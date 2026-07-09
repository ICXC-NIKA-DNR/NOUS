# Contributing

Thanks for helping build NOUS.

## Ground rules

- Node.js ≥ 22.18 — the suite runs the TypeScript sources directly via Node's
  type stripping, so there's no build step to test.
- `npm test` must pass before any PR. It type-checks the project (`tsc
  --noEmit`) and runs the full suite (`src/**/__tests__/` — core, UI, state,
  plot, CAS).
- Bug fixes in `src/core/` land with a regression test.
- `src/core/` stays pure TypeScript: no DOM, React, or Tauri imports.
- Input-syntax changes must update `parser.test.ts` — those tests are the
  spec of record.
- New user-facing errors should carry a `Suggestion` (see `src/core/errors.ts`)
  whenever a likely fix exists. Generic error strings get rejected in review.
- Dark theme only. Curve colors ship as two palettes (Vivid default,
  Accessible opt-in); the Accessible set must stay distinguishable under
  deuteranopia / protanopia / tritanopia.
- Commit messages: `M<milestone>: <what>` (e.g. `M2: implicit curve marching
  squares`), committing at each sub-milestone, not only whole milestones.

## Getting started

See the build instructions in `README.md`, then pick up the next unchecked
milestone in `PLAN.md`. Architecture constraints live in `CLAUDE.md`.

## Optional: auto-push on commit

If you'd like every local commit to push to your fork automatically (so your
history mirrors to GitHub without a manual `git push`), install the provided
post-commit hook:

```sh
cp scripts/git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

Git hooks aren't shared by `clone`, so this is per-contributor and opt-in. The
hook runs *after* the commit is finalized — a failed push (no network, auth,
diverged branch, no `origin`) prints a clear message and never affects the
commit itself. It's purely a convenience over manual pushing: not CI, not
release automation.

## Filing issues

Include your OS, the expression(s) involved, and the local error-log file
(its path is shown in the sidebar). Nothing is ever sent automatically; logs
stay on your machine.
