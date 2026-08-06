package cloudflare

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
)

// Asset is one file of the relay's web bundle.
type Asset struct {
	Path string // e.g. "/index.html", "/assets/index-abc.js"
	Body []byte
}

// noContentType is Cloudflare's sentinel for "serve this file without a
// Content-Type header at all", which is what it does for a part whose type it
// cannot otherwise place.
const noContentType = "application/null"

// assetContentTypes is the type served for each extension the web bundle can
// contain. This is a fixed table rather than a call into the `mime` package
// alone because mime.TypeByExtension consults system files (/etc/mime.types
// and the Windows registry): letting it decide would mean the Content-Type a
// user's browser sees depends on the machine the deploy ran from.
//
// The type set here is the type Cloudflare serves the asset with forever
// after — it is read off the part header at upload time, not re-derived later.
var assetContentTypes = map[string]string{
	".css":         "text/css; charset=utf-8",
	".gif":         "image/gif",
	".htm":         "text/html; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".ico":         "image/x-icon",
	".jpeg":        "image/jpeg",
	".jpg":         "image/jpeg",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".mjs":         "text/javascript; charset=utf-8",
	".png":         "image/png",
	".svg":         "image/svg+xml",
	".ttf":         "font/ttf",
	".txt":         "text/plain; charset=utf-8",
	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
	".webp":        "image/webp",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".xml":         "application/xml",
}

// contentTypeOf picks the type an asset will be served with.
func contentTypeOf(a Asset) string {
	ext := strings.ToLower(path.Ext(a.Path))
	if ct, ok := assetContentTypes[ext]; ok {
		return ct
	}
	// Anything outside the table is rare enough that a system lookup is a
	// better guess than none, and a wrong guess here only affects that one file.
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return noContentType
}

// hashOf computes the content-address Cloudflare files an asset under: sha256
// over the base64 of the contents concatenated with the extension (without its
// dot), hex, truncated to 32 characters.
//
// The shape of this is worth recording, because it is not a plain digest of the
// file and the documentation does not specify it at all:
//
//   - The hash is opaque to Cloudflare. It is a storage key and a dedup key,
//     not a checksum the server recomputes — Cloudflare's own clients disagree
//     about the algorithm (wrangler uses BLAKE3 over this same preimage; the
//     Terraform provider uses sha256 over the raw bytes), and the Workers for
//     Platforms documentation goes as far as recommending callers *salt* it,
//     which no server could verify. What is fixed is the width: the asset
//     runtime's manifest stores 16 bytes, hence exactly 32 hex characters.
//   - This particular recipe is the one in Cloudflare's own published example
//     for driving this API without wrangler, so it is the best-attested choice
//     that stays inside the Go standard library.
//   - The extension is part of the preimage on purpose. Two files with
//     identical bytes but different types must not collapse onto one address,
//     or one of them would be served with the other's Content-Type.
//
// The only real obligation is to be consistent from one deploy to the next, so
// that unchanged files keep their address and Cloudflare can skip re-uploading
// them. Changing this function would force a one-time full re-upload.
func hashOf(a Asset) string {
	ext := strings.TrimPrefix(path.Ext(a.Path), ".")
	sum := sha256.Sum256([]byte(base64.StdEncoding.EncodeToString(a.Body) + ext))
	return hex.EncodeToString(sum[:])[:32]
}

// bounded caps a server-supplied string at max on its way into an error
// message. Nothing Cloudflare sends is trusted to be a length a terminal can
// take.
func bounded(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// maxHashChars is the bound for a content hash quoted back at the user. A hash
// is 32 characters; anything longer is a response worth truncating.
const maxHashChars = 64

// manifestEntry describes one file to the upload session.
type manifestEntry struct {
	Hash string `json:"hash"`
	Size int    `json:"size"`
}

// uploadAssets runs the direct-upload session and returns the completion token
// that the script upload must present to attach these assets.
//
// The flow is: register a manifest of every file, and Cloudflare answers with
// the subset it does not already hold, batched into buckets. Upload each
// bucket. The last one comes back with the completion token.
func (c *Client) uploadAssets(ctx context.Context, accountID, script string, assets []Asset) (string, error) {
	manifest := make(map[string]manifestEntry, len(assets))
	byHash := make(map[string]Asset, len(assets))
	for _, a := range assets {
		// Manifest keys are the URL paths the files will be served at, and
		// Cloudflare requires them absolute. Catching this here costs nothing
		// and beats the alternative: a rejected session whose error names the
		// API's own validation rule rather than the file that broke it — and
		// which arrives after the caller has already built the whole bundle.
		if !strings.HasPrefix(a.Path, "/") {
			return "", fmt.Errorf("cloudflare: asset path %q must start with %q", a.Path, "/")
		}
		h := hashOf(a)
		manifest[a.Path] = manifestEntry{Hash: h, Size: len(a.Body)}
		byHash[h] = a
	}

	body, err := json.Marshal(struct {
		Manifest map[string]manifestEntry `json:"manifest"`
	}{manifest})
	if err != nil {
		return "", fmt.Errorf("cloudflare: encoding the asset manifest: %w", err)
	}

	raw, err := c.call(ctx, apiCall{
		method:      http.MethodPost,
		path:        fmt.Sprintf("/accounts/%s/workers/scripts/%s/assets-upload-session", accountID, script),
		contentType: "application/json",
		body:        body,
	})
	if err != nil {
		return "", err
	}
	var session struct {
		JWT     string     `json:"jwt"`
		Buckets [][]string `json:"buckets"`
	}
	if err := json.Unmarshal(raw, &session); err != nil {
		return "", fmt.Errorf("cloudflare: could not read the asset upload session: %w", err)
	}
	// Without a session token there is nothing to authenticate the upload with,
	// and an empty bearer would fall back to the account API token — sending the
	// user's credential to an endpoint that should only ever see a short-lived
	// scoped JWT. Stop here instead.
	if session.JWT == "" {
		return "", fmt.Errorf("cloudflare: the asset upload session returned no token")
	}

	// Cloudflare already holds every file, so there is nothing to upload and
	// the session token is itself the completion token.
	if len(session.Buckets) == 0 {
		return session.JWT, nil
	}

	completion := ""
	for _, bucket := range session.Buckets {
		jwt, err := c.uploadBucket(ctx, accountID, session.JWT, bucket, byHash)
		if err != nil {
			return "", err
		}
		// Only the upload that completes the manifest carries the token.
		if jwt != "" {
			completion = jwt
		}
	}
	if completion == "" {
		return "", fmt.Errorf("cloudflare: uploaded every asset bucket but got no completion token back")
	}
	return completion, nil
}

// uploadBucket uploads one batch of assets, authenticated with the session JWT
// rather than the API token. It returns the completion token if this upload
// finished the manifest, and the empty string otherwise.
func (c *Client) uploadBucket(ctx context.Context, accountID, sessionJWT string, bucket []string, byHash map[string]Asset) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, h := range bucket {
		asset, ok := byHash[h]
		if !ok {
			// Cloudflare asked for a file this deploy does not have. Uploading
			// the rest would produce a Worker missing an asset, so stop.
			// h came off the wire, so it is quoted and bounded before it reaches
			// a terminal: a broken or hostile response should not be able to
			// write arbitrary bytes into the user's screen.
			return "", fmt.Errorf("cloudflare: the upload session asked for hash %q, which is not in this deploy's manifest", bounded(h, maxHashChars))
		}
		// The field name and filename are both the hash: this endpoint is
		// addressed by content, and the body is base64 because the request
		// carries base64=true.
		part, err := mw.CreatePart(partHeader(h, h, contentTypeOf(asset)))
		if err != nil {
			return "", fmt.Errorf("cloudflare: building the asset upload: %w", err)
		}
		enc := base64.NewEncoder(base64.StdEncoding, part)
		if _, err := enc.Write(asset.Body); err != nil {
			return "", fmt.Errorf("cloudflare: building the asset upload: %w", err)
		}
		if err := enc.Close(); err != nil {
			return "", fmt.Errorf("cloudflare: building the asset upload: %w", err)
		}
	}
	if err := mw.Close(); err != nil {
		return "", fmt.Errorf("cloudflare: building the asset upload: %w", err)
	}

	raw, err := c.call(ctx, apiCall{
		method:      http.MethodPost,
		path:        fmt.Sprintf("/accounts/%s/workers/assets/upload?base64=true", accountID),
		bearer:      sessionJWT,
		contentType: mw.FormDataContentType(),
		body:        buf.Bytes(),
	})
	if err != nil {
		return "", err
	}
	var result struct {
		JWT string `json:"jwt"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("cloudflare: could not read the asset upload response: %w", err)
	}
	return result.JWT, nil
}
