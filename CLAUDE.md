# gcalc — project spec for Claude Code

Free, open-source, cross-platform desktop graphing calculator.
Desmos-like interactivity, GeoGebra-level CAS depth. MIT licensed.
Primary users: serious STEM/math users. Secondary: students/educators.

Read `PLAN.md` for the milestone sequence. Work milestone by milestone; do not
start a milestone until the previous one's acceptance criteria pass.

## Stack (fixed — do not substitute)

- Tauri v2 (Rust backend + WebView), React 18 + TypeScript (strict) frontend, Vite.
- No cloud services, no backend server, no accounts, no telemetry. Everything local.
- Tests: node:test (zero-dep, Node ≥22.18 runs the .ts files directly) for the TS core. `npm test` must pass before any milestone is "done".

## Hard constraints (non-negotiable)

1. **Performance target:** smooth live redraw with ≥50 active expressions/sliders
   simultaneously. This is a hard target, not an aspiration. Design for it from M2
   (see "compile, don't interpret" below), verify with the perf harness in M3.
2. **Dark mode is the only theme.** Near-black charcoal background (not pure #000).
   Pastel curve palette (soft blues/pinks/greens/purples/yellows) auto-assigned in
   fixed rotation, verified distinguishable under deuteranopia/protanopia/tritanopia.
3. **Typography:** UI font = Inter or IBM Plex Sans (bundled, open-source; never
   Arial). Math display = KaTeX-style rendering: italic variables, upright function
   names, proper super/subscripts. Math rendering is separate from the UI font.
4. **Angle mode** (deg/rad) is a single global setting applied consistently across
   plotting, numeric eval, and CAS. It already exists in `src/core/evaluator.ts`
   (`EvalContext.angleMode`) — thread it through, never fork it.
5. **Numeric display precision** is user-configurable and applied consistently to
   every numeric output in the app.

## Architecture decisions (already made — follow these)

- **The AST is the single source of truth.** One parser
  (`src/core/parser.ts`) feeds both the plotting engine and the CAS layer. Never
  write a second parser or regex-based expression handling.
- **`src/core/` is pure TypeScript.** No DOM, no React, no Tauri APIs in core.
  This keeps it unit-testable and portable. UI lives in `src/ui/`, plotting in
  `src/plot/`, CAS in `src/cas/`.
- **Compile, don't interpret, on the hot path.** The recursive evaluator in
  `evaluator.ts` is the reference implementation. For plotting/slider redraw,
  M3 adds `compile(ast): (env) => number` that emits a JS closure per expression;
  the recursive evaluator remains the correctness oracle in tests.
- **CAS goes behind an interface.** Define `CasEngine` (simplify, solve, diff,
  integrate, limit — each returning both exact and approximate forms) in
  `src/cas/engine.ts`. The UI and inline `derivative(...)` syntax both route
  through it. Rationale: see licensing note below.
- **Errors carry machine-applicable suggestions.** `src/core/errors.ts` defines
  the shape: every user-facing syntax/eval error should, where possible, include
  a `Suggestion` (insert/replace edit) the UI renders as a clickable fix.
  Unknown function → nearest-name suggestion; undefined variable → create-slider
  suggestion. Extend this pattern; never surface a bare generic error string.
- **Undo/redo:** all document mutations go through a single command/action layer
  from the moment folders exist (M7); don't retrofit it later.
- **Persistence format:** `.gcalc` files are versioned JSON
  (`{ "format": "gcalc", "version": 1, ... }`). The share-code feature is the same
  JSON, compact-serialized + base64. One serializer, two transports.

## ⚠ Open licensing decision — RESOLVED, see CAS_SPEC.md

> **Resolution (M5):** the CAS is built from scratch in TypeScript, MIT,
> inside this repo — no Giac, no GPL code, no WASM boundary. `CAS_SPEC.md`
> supersedes this section and PLAN.md's original M5. The text below is kept
> for the historical record of the decision.

The spec asks for Giac compiled to WASM. Giac is **GPL-3.0**; this project is
**MIT**. Options, in rough order of preference:

1. Make the CAS a **runtime-optional plugin**: app is MIT and fully functional
   (numeric + plotting) without it; Giac WASM is downloaded/enabled separately by
   the user, with the GPL boundary documented. Verify this satisfies GPL linking
   terms before committing.
2. Swap to a permissively-licensed CAS behind the same `CasEngine` interface.
3. Relicense the whole app GPL-3.0 (conflicts with the stated MIT requirement —
   requires the maintainer's sign-off, not yours).

Ask the maintainer to choose. Do not silently bundle GPL code into an MIT repo.

## Conventions

- TypeScript `strict: true`; no `any` in `src/core/`.
- Every bug fix in `src/core/` lands with a regression test.
- Commit messages: `M<milestone>: <what>` (e.g. `M2: implicit curve marching squares`).
- Keep `README.md` build instructions honest — if a step doesn't work, fix the
  step or the doc in the same commit.

## Commands

```
npm install          # frontend deps
npm test             # type-check + core parser/evaluator suite (node:test)
npm run tauri dev    # run the desktop app (requires Rust toolchain)
npm run tauri build  # release build
```

## What already exists (do not rewrite from scratch)

- `src/core/`: lexer, Pratt parser (Desmos-style input: implicit multiplication,
  `^`, chained inequalities, `{...}` domain restrictions, points, lists,
  paren-less function application like `sin 2x`), recursive numeric evaluator
  with deg/rad support, structured errors with fix suggestions, ~80 passing
  tests. Read the test files first — they are the spec of record for input syntax.
- Tauri/Vite scaffold. It was written against Tauri v2 without network access;
  if versions have drifted, prefer regenerating config files with the current
  `create-tauri-app` / `tauri` CLI over hand-patching, then re-apply the app
  identifier and window settings.
