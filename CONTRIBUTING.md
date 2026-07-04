# Contributing

Thanks for helping build gcalc.

## Ground rules

- `npm test` must pass before any PR. It type-checks the project and runs the
  core suite (`src/core/__tests__/`).
- Bug fixes in `src/core/` land with a regression test.
- `src/core/` stays pure TypeScript: no DOM, React, or Tauri imports.
- Input-syntax changes must update `parser.test.ts` — those tests are the
  spec of record.
- New user-facing errors should carry a `Suggestion` (see `src/core/errors.ts`)
  whenever a likely fix exists. Generic error strings get rejected in review.
- Dark theme only; palette changes must remain distinguishable under common
  color-vision deficiencies.

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

Include your OS, the expression(s) involved, and — once the app ships error
logging — the local log file. Nothing is ever sent automatically; logs stay
on your machine.
