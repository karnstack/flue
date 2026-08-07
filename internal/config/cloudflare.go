package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const cloudflareFileName = "cloudflare.json"

// Cloudflare is the stored Cloudflare credential and the account it deploys
// into: what makes "update the relay" a click instead of a trip to the token
// page.
//
// Stored by explicit product decision: the token is an account-level Workers
// credential and flue keeps it the way it keeps the relay secret — one 0600
// file in the config directory, owner-readable and nothing else. The user is
// doing this on their own machine for their own account; the file is theirs
// to delete, and everything that reads it works (by asking again) when it is
// gone.
type Cloudflare struct {
	// Token is the API token setup verified. Never logged, never echoed into
	// an error, never carried by any endpoint response — reads of this file
	// hand it to the Cloudflare API and nowhere else.
	Token string `json:"token"`
	// AccountID and AccountName are the account the relay was deployed into,
	// recorded so the UI can say where the relay lives and so an update needs
	// no account picker.
	AccountID   string `json:"account_id"`
	AccountName string `json:"account_name,omitempty"`
}

func cloudflarePath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, cloudflareFileName), nil
}

// LoadCloudflare reads cloudflare.json. ok is false when nothing is stored.
func LoadCloudflare() (Cloudflare, bool, error) {
	path, err := cloudflarePath()
	if err != nil {
		return Cloudflare{}, false, err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Cloudflare{}, false, nil
	}
	if err != nil {
		return Cloudflare{}, false, err
	}
	var c Cloudflare
	if err := json.Unmarshal(b, &c); err != nil {
		// Named without contents, for the same reason relay.json's parse
		// error is: this file holds a credential and this error reaches logs.
		return Cloudflare{}, false, fmt.Errorf("config: %s could not be parsed: %w", cloudflareFileName, err)
	}
	if c.Token == "" {
		return Cloudflare{}, false, nil
	}
	return c, true, nil
}

// SaveCloudflare writes cloudflare.json at 0600, replacing whatever was
// there — the same fresh-inode rename dance SaveRelay does, for the same
// concurrent-reader reasons.
func SaveCloudflare(c Cloudflare) error {
	path, err := cloudflarePath()
	if err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "cloudflare-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below has succeeded
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// DeleteCloudflare removes the stored credential; absent is success.
func DeleteCloudflare() error {
	path, err := cloudflarePath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
