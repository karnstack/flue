# flue — agent notes

## Workflow

- `main` is protected. Never commit to or merge into `main` locally.
- All work happens on a branch (worktrees under `.claude/worktrees/`), and
  lands via a pull request — always, even for one-line fixes. Push the
  branch, open the PR with `gh pr create`, and hand the URL back.
- Run the affected test surface before pushing: `cd web && npx vitest run`
  and `npm run lint` for web changes, `go test ./...` for Go, `make test`
  for anything cross-cutting. web's `styles.build.test.ts` is a real vite
  build and is the guard for the Tailwind prose scanner — comments in
  scanned web sources can compile stray CSS rules; see the notes at the top
  of `web/src/styles.css` before writing prose there.
