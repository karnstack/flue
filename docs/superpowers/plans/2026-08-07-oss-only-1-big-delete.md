# OSS-only Phase 1: The Big Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the SaaS entirely — `app/`, the daemon's control-plane client, `flue link`, the relay's signed-token mode, the web client's control-plane path — leaving a green, smaller tree.

**Architecture:** Pure deletion plus the minimal stitches that keep every remaining suite green. No new features. Spec: `docs/superpowers/specs/2026-08-07-flue-oss-only-design.md`. Later phases (relay id-routing, `relay join`, the picker, docs rewrite) get their own plans against the cleaned tree.

**Tech Stack:** Go 1.26, pnpm 11 via mise (`mise exec --` if the shell isn't activated), vitest 4, wrangler.

## Global Constraints

- Every task ends with `make lint test` green and a commit on `main`.
- pnpm, never npm/npx (repo pins toolchain in `mise.toml`).
- **Keep** per-device key pinning in `web/src/crypto/keys.ts` (`savePinnedDaemonKeyFor` and friends) — Phase 4's picker needs it. Deleting it is a plan violation.
- Deletion order is dependency order: leaves first (`app/`), then Go, then relay, then web, then docs. Do not reorder.
- Commit messages follow the repo's narrative style (`fix(web): a channel that flaps…`); no AI attribution beyond the standard trailer.

---

### Task 1: Delete `app/` and its build wiring

**Files:**
- Delete: `app/` (entire directory)
- Modify: `Makefile` (targets `app`, `test-app`; `test` and `lint` lines)
- Modify: `.github/workflows/ci.yml:30` (drop `app/pnpm-lock.yaml` from `hashFiles`)

**Interfaces:**
- Consumes: nothing.
- Produces: a tree where nothing references `app/`; `make test` = `test-go test-web test-relay`.

- [ ] **Step 1: Verify nothing outside `app/` imports it**

Run: `grep -rn "app/" Makefile .github/workflows/ci.yml scripts/ --include='*' | grep -v 'apply\|web-dev\|snapshot'`
Expected: only the Makefile targets and the ci.yml hashFiles line found above.

- [ ] **Step 2: Delete and unwire**

```bash
git rm -r app
```

In `Makefile`: delete the `app:` and `test-app:` target blocks (lines 24–29 and 57–58 region), remove `test-app` from the `test:` line, remove the `cd app && pnpm lint` line from `lint:`, and remove `app` from the `.PHONY` list and from `lint:`'s prerequisites.

In `.github/workflows/ci.yml` line 30, change:
```yaml
key: pnpm-store-${{ runner.os }}-${{ hashFiles('web/pnpm-lock.yaml', 'relay/pnpm-lock.yaml', 'app/pnpm-lock.yaml') }}
```
to:
```yaml
key: pnpm-store-${{ runner.os }}-${{ hashFiles('web/pnpm-lock.yaml', 'relay/pnpm-lock.yaml') }}
```

- [ ] **Step 3: Verify green**

Run: `make lint test`
Expected: PASS (go + web + relay; no app anywhere in output).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore!: delete the flue.sh control plane

flue is open-source-only: no accounts, no hosted anything. The spec
(docs/superpowers/specs/2026-08-07-flue-oss-only-design.md) records
the decision; this commit is its first and largest consequence."
```

---

### Task 2: Delete the daemon's control-plane client and `flue link`

**Files:**
- Delete: `internal/controlplane/` (all five files)
- Delete: `cmd/flue/link.go`, `cmd/flue/link_test.go`
- Modify: `internal/config/relay.go` (hosted-mode fields), `cmd/flue/main.go` (link registration, flue.sh status/enable branches), `internal/transport/relay` (hosted-credential branch, found by grep)
- Test: existing `go test ./...`

**Interfaces:**
- Consumes: Task 1 (tree without `app/`).
- Produces: `config.Relay` = `{URL, Origin, Secret string}` only; every `flue link` / flue.sh mention gone from Go.

- [ ] **Step 1: Map every reference before cutting**

Run: `grep -rln 'controlplane\|flue link\|flue.sh' cmd/ internal/ --include='*.go'`
Expected: `cmd/flue/main.go`, `cmd/flue/link.go(+_test)`, `internal/controlplane/*`, `internal/config/relay.go`, and possibly `internal/transport/relay/*.go`. Every file this prints must appear in a later step of this task; if one doesn't, stop and extend the task rather than leaving it.

- [ ] **Step 2: Delete the packages**

```bash
git rm -r internal/controlplane cmd/flue/link.go cmd/flue/link_test.go
```

- [ ] **Step 3: Strip hosted mode from `internal/config/relay.go`**

Remove the hosted-enrolment fields from the `Relay` struct (everything except `URL`, `Origin`, `Secret`), the doc-comment branches describing flue.sh (`config/relay.go:27–34` region), and any `omitempty` justification referencing a hosted relay.json. Keep `LoadRelay`/`SaveRelay` signatures unchanged.

- [ ] **Step 4: Strip `cmd/flue/main.go`**

Delete: the `flue link` usage line (`main.go:107`), the hosted-relay warning branch (`main.go:305–316` region — "relay.json names a flue.sh enrolment…"), and the flue.sh arms of `flue status` (`main.go:1234–1261` region — reachability copy, "names both a self-hosted secret and a flue.sh enrolment"). Each site: keep the self-host arm, delete the hosted arm and the `if` that chose between them.

- [ ] **Step 5: Compile-driven sweep**

Run: `go build ./... 2>&1 | head -30`
Fix every remaining reference the compiler names (transport/relay's hosted-credential branch collapses to always-`Secret`). Re-run until clean.

- [ ] **Step 6: Tests green**

Run: `make test-go`
Expected: PASS; packages list no longer contains `internal/controlplane`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore(flue)!: the daemon forgets flue.sh

flue link, the control-plane client, and relay.json's hosted
enrolment go with the control plane they spoke to. A relay.json is
now one shape: origin plus shared secret."
```

---

### Task 3: Collapse the relay to self-host-only auth

**Files:**
- Delete: `relay/test/saas-auth.test.ts` (and any `saas-*.test.ts`)
- Modify: `relay/src/channel-auth.ts` → keep only the secret path (or fold the survivors into `hub.ts`/`index.ts` if under ~40 lines), `relay/vitest.config.ts` (single project), `relay/wrangler.jsonc` (drop `RELAY_SIGNING_SECRET` mentions)
- Test: `relay/test/*.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (independent package).
- Produces: daemon leg authorized by `Bearer <DAEMON_SECRET>` compare only; client and pair legs credential-less; `RelayEnv` loses `RELAY_SIGNING_SECRET`.

- [ ] **Step 1: Map the mode seam**

Run: `grep -n 'RELAY_SIGNING_SECRET\|authorizeToken\|channel-auth' relay/src/*.ts relay/test/*.ts relay/wrangler.jsonc`
Expected: `channel-auth.ts` (both modes), imports in `hub.ts`/`index.ts`, the saas test file, the vitest saas project bindings.

- [ ] **Step 2: Delete the saas tests and vitest project**

```bash
git rm relay/test/saas-*.test.ts
```
In `relay/vitest.config.ts`: replace the two-project `projects:` array with the single self-host shape (keep the `HANDSHAKE_TIMEOUT_MS: 50, PAIR_TIMEOUT_MS: 250, DAEMON_SECRET: 'test-secret'` bindings; delete the `RELAY_SIGNING_SECRET` project and the mode commentary lines 22–35).

- [ ] **Step 3: Strip token mode from `channel-auth.ts`**

Keep: `bearerToken()`, the self-host daemon check (constant-time compare of the bearer against `env.DAEMON_SECRET`, refusing when unset), the credential-less client/pair answers. Delete: `authorizeToken`, every `role:` / `acc` / `dev` claim mention, the SaaS doc-comment branches. Update `hub.ts`/`index.ts` imports to the surviving names unchanged.

- [ ] **Step 4: Full relay suite green**

Run: `cd relay && mise exec -- pnpm test && mise exec -- pnpm lint`
Expected: one vitest project, all remaining tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(relay)!: one mode — the shared secret

The signed-token mode existed for a relay flue.sh operated. Nobody
operates it. What remains is the relay you deploy: one daemon
secret, credential-less clients, Noise as the boundary."
```

---

### Task 4: Delete the web client's control-plane path (keep pinning)

**Files:**
- Delete: `web/src/relay/control-plane.ts`, `web/src/relay/control-plane.test.ts`
- Modify: `web/src/relay/mode.ts` (drop the SaaS arm), `web/src/relay/session.ts`, `web/src/main.tsx` + `web/src/lib/url.ts` (fragment handoff `takeRelayHandoff` → self-host token handling only), `web/src/client/client.ts` (+test: `token: () => Promise<string>` refresh path reverts to the static self-host credential shape)
- **Keep untouched:** `web/src/crypto/keys.ts` per-device pinning (`savePinnedDaemonKeyFor` etc.) and its tests.

**Interfaces:**
- Consumes: Task 3's relay (credential-less client leg).
- Produces: web connects to a relay with no control-plane fetches anywhere in `src/`; `grep -rn 'relay-token\|control-plane' web/src` returns nothing.

- [ ] **Step 1: Map the seam**

Run: `grep -rn 'control-plane\|relay-token\|takeRelayHandoff' web/src --include='*.ts*'`
Expected: the files listed above and their tests — same rule as Task 2 Step 1: every hit must be covered by a step here.

- [ ] **Step 2: Delete and stitch**

```bash
git rm web/src/relay/control-plane.ts web/src/relay/control-plane.test.ts
```
In `mode.ts`: remove the SaaS mode arm and its detection; the relay door resolves to the self-host shape. In `main.tsx`/`url.ts`: reduce `takeRelayHandoff` to the pre-T15 self-host reads it wraps (keep the scrub-the-fragment behavior — it predates SaaS and stays). In `client.ts`: `RelayIdentity.token` returns to the non-refreshing self-host form; delete the per-dial refresh test cases in `client.test.ts`, keep the backoff tests (recently hardened — do not touch their timings).

- [ ] **Step 3: Pinning still present (the guard-rail)**

Run: `grep -n 'savePinnedDaemonKeyFor' web/src/crypto/keys.ts`
Expected: found. If this grep is empty you have deleted Phase 4's foundation — revert the task and re-cut.

- [ ] **Step 4: Web suite green**

Run: `cd web && mise exec -- pnpm test && mise exec -- pnpm lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(web)!: the client stops phoning a control plane

Token refresh and the four-part fragment handoff served the SaaS
relay. Per-device key pinning stays: one origin will front many
machines again, just not ours."
```

---

### Task 5: Docs prune, full green, push

**Files:**
- Delete: `docs/SAAS.md`
- Modify: `docs/FOLLOW-UPS.md` (SaaS-only sections, incl. §14), `README.md` (any flue.sh-account mention), `docs/RELAY.md` (delete the SaaS-mode paragraph — the "second mode it enters only when RELAY_SIGNING_SECRET is bound" bullet; full multi-machine rewrite is Phase 5, not now)

**Interfaces:**
- Consumes: Tasks 1–4 (docs describe what remains).
- Produces: `grep -rin 'app.flue.sh\|control plane\|flue link' README.md docs/ --include='*.md' | grep -v superpowers` returns nothing.

- [ ] **Step 1: Cut**

```bash
git rm docs/SAAS.md
```
Prune FOLLOW-UPS: delete sections that exist only to serve the SaaS (§14 SaaS browser sessions among them); keep entries about the relay/daemon/web that stand on their own. README + RELAY.md: remove account/SaaS sentences; do not rewrite structure.

- [ ] **Step 2: Sweep for strays**

Run: `grep -rin 'app.flue.sh\|control plane\|flue link' README.md docs/ spec/ --include='*.md' | grep -v superpowers`
Expected: empty (superpowers specs/plans are history and exempt).

- [ ] **Step 3: Everything green, one last time**

Run: `make lint test`
Expected: PASS across go, web, relay.

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "docs: the paperwork of the deletion

SAAS.md goes with the service it documented; FOLLOW-UPS keeps only
work that still exists to follow up on."
git push
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: CI conclusion `success`.

---

## Self-review notes

- Spec coverage: this plan implements the spec's "What is deleted" section and migration step 1 only — steps 2–5 are Phases 2–5, each planned against the post-delete tree.
- Line numbers (`main.go:305–316`, `ci.yml:30`, …) are anchors from today's tree; trust the named symbol over the number if they drift.
- Every task's Step-1 grep is the contract: a hit not covered by a later step means the task is incomplete — extend it, don't skip it.
