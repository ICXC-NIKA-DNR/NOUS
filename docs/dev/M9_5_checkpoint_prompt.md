# M9.5 User-Defined Functions — Checkpoint Prompt

This is a checkpoint session. Treat it as a hard save point: after this work
is done and accepted, we lock M9.5 in and move forward from here. Take the
time to do this right rather than fast.

## Context

M9 is locked. M9.5 adds user-defined functions — the feature M9.1's
"defined `f(x)` autocompletes" criterion assumed and the language turned out
not to have: today `f(x) = x^2` parses as the product `f·(x) = x^2`, and
`definitionName` only recognizes scalar `ident = value` definitions.

What already exists — build on it, don't duplicate:

- **The evaluator is done.** `EvalContext.functions:
  Map<string, UserFunction>` (params + body AST) with arity checking and
  nearest-name errors already works in `src/core/evaluator.ts`. It is the
  reference semantics for everything in this milestone; nothing else may
  disagree with it.
- **The two-pass analysis shape exists.** App.tsx pass 1 collects definition
  names, pass 2 analyzes with that set. Function names ride the same flow.
- **`compile.ts` deliberately does NOT support user functions** (hot-path
  comment at the top of the file). That stays true — see inlining below.
- **AST inline-expansion precedent:** `expandCas` in `src/ui/analyze.ts`
  already rewrites call nodes into expression trees before compilation.
  User-call inlining follows the same pattern.

Decisions already made by the maintainer — do not relitigate:

1. **Parens required** at user-function call sites (`f(x)`, never `f x`).
   Paren-less application stays built-ins-only. Greedy letter-run
   segmentation must never capture a user function name into a bare run:
   `abx` stays `a·b·x` even when `ab(x) = …` is defined.
2. **Multi-letter names are functions-only.** Slider/value definitions stay
   single-letter. (`amp = 2` remains `a·m·p = 2` — an error — not a slider.)
3. **Structured errors, never silent breakage:** shadowing a reserved name
   (built-in functions, constants, `x`/`y`/`theta`/`r`) and recursive
   definitions (direct or mutual) are both rejected with `Diagnostic`s,
   with machine-applicable suggestions where one exists.

## Part 1 — M9.5.1: Naming + parsing (two-pass pre-scan)

- Definition-head pre-scan: a row whose text starts `word(params) =` (word =
  letter run, params = comma-separated single letters) yields a candidate
  function name. This is a name harvester, NOT a second expression parser —
  keep it dumb, head-anchored, and in core with tests.
- App pass 1 collects these names; pass 2 lexes/parses every row with them
  as `extraNames` + `functionNames`, so `myfn(3)` parses as a call
  everywhere in the document.
- `definitionParts`/analysis gains a function-definition interpretation:
  `call-shaped LHS = body` → `{ kind: 'function-definition', name, params,
  body }`. Params shadow outer names inside the body; free variables in the
  body that aren't params/sliders are errors at use time (same as today).
- Reserved-name shadowing (`sin(x) = 1`) → structured error at the
  definition row. Duplicate definitions of the same name → structured error
  on the later row.
- Bare multi-letter runs NEVER resolve to user functions (decision 1):
  segmentation considers built-ins/constants only, plus harvested names
  ONLY when directly followed by `(`.

**Accept (M9.5.1):** `f(x) = x^2` and `myfn(a, b) = a b` analyze as function
definitions; `f(9)` parses as a call in other rows; `abx` still parses as
`a·b·x` with `ab(x)=…` defined; `sin(x) = 1` errors; all node:test-covered
including the pre-scan's negative cases (`2(x+1) = y`, `f (x) =`, mid-row
`g(x) =`).

## Part 2 — M9.5.2: Evaluation + plotting (inlining)

- Wire the harvested definitions into `EvalContext.functions` so the
  recursive evaluator handles `f(9)` rows — value rows, CAS operands, and
  numeric readouts all get user calls "for free" through the evaluator.
- **Cycle detection first:** build the call graph of definitions; any cycle
  (including `f → f`) marks every definition on it with a structured error
  and excludes them from scope. This runs before any inlining so nothing
  can hang.
- **Inlining for the hot path:** before `compile()`, rewrite user calls in
  plot-bound ASTs by substituting argument ASTs into the body
  (capture-safe: rename/param-scope like `expandCas`). `compile.ts` itself
  does not change. Arity mismatches error at analysis time with the same
  message shape the evaluator produces.
- Cross-check (the M5/CAS_SPEC pattern): for a set of representative
  definitions, the inlined-compiled result must agree with the recursive
  evaluator (reference) within tolerance, property-tested.

**Accept (M9.5.2):** `f(9)` shows 81; `y = f(x) + f(2x)` plots and tracks a
slider drag smoothly (dirty-tracking fingerprints account for the
definition's body, so editing `f` re-samples dependents); `f(x) = f(x-1)`
and a mutual `f`/`g` cycle produce structured errors and don't hang;
compile-vs-evaluator property tests pass.

## Part 3 — M9.5.3: UX integration

- Autocomplete: defined function names enter the vocabulary with paren
  insert (`myfn(`) — this satisfies M9.1's deferred criterion. Update the
  M9 status note in PLAN.md accordingly.
- CAS actions on rows referencing user functions operate on the INLINED
  body (derivative of `f(x) + x` works when `f` is inlineable).
- Sliders inside function bodies work: `f(x) = a x^2` re-plots dependents
  live during an `a` drag.
- Persistence: `.nous` save/open and share codes round-trip documents with
  function definitions (should be free — sources are text — but verify and
  add a round-trip test case containing one).
- Error quality: calling with wrong arity, calling an excluded (cyclic)
  definition, and referencing an undefined multi-letter function each show
  a specific message; nearest-name suggestions include user function names.

**Accept (M9.5.3):** typing `f` in a fresh row offers `f(`; derivative-of-
row-using-`f` inserts a correct result; `a`-slider drag animates
`y = f(x)`; a saved document with `f(x) = a x^2` round-trips; wrong-arity
`f(1, 2)` errors with the arity message.

## Acceptance gate (do not declare M9.5 done without these passing)

- `npm test` passes in full; every new core behavior (pre-scan, definition
  analysis, cycle detection, inlining, arity errors) has node:test coverage;
  inlined-compile vs recursive-evaluator property tests included.
- The PLAN.md accept line holds end-to-end in the preview: define → call →
  81; plot with slider; structured errors for shadowing/recursion;
  autocomplete offers `f(`; persistence round-trips.
- Perf: the ≥50-expression target holds — inlining happens once per
  analysis, never per sample; confirm with the perf HUD that a slider drag
  driving an inlined function stays at target fps.
- No regressions in implicit multiplication: existing parser/lexer test
  suite untouched and green (`xy`, `2x`, `sin 2x`, `abx`).
- Committed at each sub-milestone boundary (M9.5.1–M9.5.3).

## Deliverable

At the end: a summary of (1) the pre-scan grammar and its rejected inputs,
(2) how inlining + cycle detection work and any capture-safety subtleties,
(3) exactly what changed in analyze/App two-pass flow, (4) confirmation the
M9.1 deferred criterion now passes, (5) acceptance-gate confirmation.
