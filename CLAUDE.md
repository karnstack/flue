# flue — agent notes

## Workflow

- `main` is protected. Never commit to or merge into `main` locally.
- All work happens on a branch (worktrees under `.claude/worktrees/`), and
  lands via a pull request — always, even for one-line fixes. Push the
  branch, open the PR with `gh pr create`, and hand the URL back.
- **pnpm only.** `web/` is a pnpm workspace (`pnpm-lock.yaml`,
  `pnpm-workspace.yaml`) and there is no `package-lock.json`. Use `pnpm
  install`, `pnpm add`, `pnpm run <script>`, and `pnpm dlx` for one-off
  binaries. Never `npm`, `npx` or `yarn`: `npm install` writes a
  `package-lock.json` and a flat `node_modules` beside the pnpm store, and
  npm's allow-scripts gate leaves esbuild's postinstall unrun, so the vite
  build in `styles.build.test.ts` fails for reasons that look nothing like
  the cause.
- Run the affected test surface before pushing: `cd web && pnpm vitest run`
  and `pnpm run lint` for web changes, `go test ./...` for Go, `make test`
  for anything cross-cutting. web's `styles.build.test.ts` is a real vite
  build and is the guard for the Tailwind prose scanner — comments in
  scanned web sources can compile stray CSS rules; see the notes at the top
  of `web/src/styles.css` before writing prose there.
