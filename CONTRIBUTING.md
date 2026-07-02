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

## Filing issues

Include your OS, the expression(s) involved, and — once the app ships error
logging — the local log file. Nothing is ever sent automatically; logs stay
on your machine.
