# M5 — Symbolic layer (from-scratch, MIT)

Supersedes the Giac-WASM approach in the original prompt. Decision: build a
scoped, from-scratch symbolic engine in TypeScript rather than integrate GPL
software. Rationale: license cleanliness (stays MIT with zero ambiguity),
matches the actual capability graphing-calculator users need, and — not
incidental — is a far better portfolio/grad-school artifact than gluing in
someone else's library. "I designed and built this" beats "I integrated this."

This file replaces the CAS section of `CLAUDE.md` / `PLAN.md` M5. Read this
before writing any M5 code.

## Scope (what "CAS" means here — be strict about this)

In scope:
1. **Simplification** — combine like terms, collect powers, fold constants,
   basic factoring (common factor, difference of squares, quadratic formula
   for degree ≤ 2), trig identity normalization (small fixed rule set).
2. **Symbolic differentiation** — full, general, exact. This is the one area
   where "as good as any CAS" is realistic, because it's a mechanical
   structural recursion over the AST with no open research problem attached.
   Every standard rule: sum/product/quotient/chain, all builtin functions in
   `evaluator.ts`.
3. **Equation solving** — linear (exact), quadratic (exact, via formula,
   complex-aware), and numeric root-finding (Newton's method + bisection
   fallback) for anything else. Not general symbolic solving — be honest in
   the UI about which case a given result came from.
4. **Indefinite integration by pattern table** — a curated table of ~150–250
   known forms (polynomials, 1/x, exp, ln, trig, basic trig products,
   u-substitution for recognizable composite forms, integration by parts for
   a fixed set of patterns like x·sin(x), x·eˣ). When nothing matches, say so
   honestly rather than guessing. This mirrors what most graphing-calculator
   CAS actually does under the hood.
5. **Definite integration** — FTC using the indefinite result where available;
   fall back to numeric quadrature (Simpson's rule / adaptive) otherwise. The
   numeric fallback means definite integrals are *always* answerable even
   when the indefinite form isn't found — this is a deliberate strength, not
   a compromise.
6. **Limits** — direct substitution, L'Hôpital's rule (built on the
   differentiation engine, one clean reuse) for indeterminate forms, one-sided
   limits.

Explicitly out of scope for v1 (document this honestly in the README — a
clear "known limitations" section is a strength in a portfolio piece, not a
weakness):
- General symbolic integration (Risch algorithm) — this is a genuinely hard,
  decades-deep research area; scoping it out on purpose is a defensible
  engineering decision, not a gap to apologize for.
- Symbolic solving of high-degree polynomials, transcendental equations, or
  systems — numeric solving covers these adequately for the target user.
- Matrix/linear algebra CAS, differential equations, series expansions —
  candidates for a v2 if the project grows.

## Architecture

- `src/cas/simplify.ts` — `simplify(expr: Expr): Expr`. Rewrite-rule engine:
  a list of `(pattern, rewrite)` rules applied bottom-up to a fixed point
  (cap iterations; a rule set should provably terminate, but cap anyway).
  Reuses the existing AST from `src/core/ast.ts` — do not invent a second
  expression type for symbolic work. Exact rational arithmetic (see below)
  keeps constant folding exact.
- `src/cas/differentiate.ts` — `differentiate(expr: Expr, wrt: string): Expr`.
  Structural recursion, one function per AST node kind, mirroring
  `evaluator.ts`'s `evaluate()` shape closely on purpose — a reader who
  understands one should immediately recognize the other. Result is run
  through `simplify()` before returning.
- `src/cas/solve.ts` — `solve(equation: Relation, wrt: string): SolveResult`.
  `SolveResult` is a tagged union: `{ kind: 'exact', solutions: Expr[] }` for
  linear/quadratic, `{ kind: 'numeric', solutions: number[] }` for
  Newton/bisection results, `{ kind: 'no-solution-found' }` — never silently
  return an empty list; the UI needs to distinguish "no real solutions" from
  "solver gave up."
- `src/cas/integrate.ts` — `integrate(expr: Expr, wrt: string): Expr | null`
  (pattern-table indefinite; null = no match) and
  `integrateDefinite(expr: Expr, wrt: string, a: number, b: number): number`
  (tries FTC via `integrate()` first, falls back to numeric quadrature —
  always succeeds barring divergence).
- `src/cas/limit.ts` — `limit(expr: Expr, wrt: string, approaching: number | 'inf' | '-inf', side?: 'left' | 'right'): number | 'diverges'`.
- `src/cas/rational.ts` — an exact `Rational` type (bigint numerator/denominator)
  used internally by `simplify` and `solve` so constant folding stays exact
  (`1/3 + 1/6 = 1/2`, not a float). This is small, self-contained, and worth
  having early — floating-point simplification bugs are the most annoying
  kind to debug.
- `src/cas/engine.ts` — the `CasEngine` interface wiring the above together,
  exactly as specified in `CLAUDE.md`. UI and inline `derivative(...)` syntax
  both route through this one interface — no change from the original plan.
- No worker/WASM boundary needed for v1 — this is all fast, synchronous
  TypeScript. Simpler than the original Giac-in-a-worker plan. Revisit only
  if profiling shows a real UI-blocking cost (unlikely at this scope).

## Milestone breakdown (replaces the single M5 in PLAN.md)

### M5.1 — Exact rational arithmetic + differentiation
`Rational` type. `differentiate()` covering every builtin in
`BUILTINS` (evaluator.ts) plus sum/product/quotient/chain/power rules,
including the tricky ones: `d/dx[f(x)^g(x)]` (logarithmic differentiation),
`d/dx[x^n]` for non-integer n.

**Accept:** differentiate ~40 hand-picked expressions (polynomials, products,
quotients, compositions, all builtins), compare against hand-verified answers
after simplification. Property test: numerically evaluate both the symbolic
derivative and a central-difference numeric approximation at several points,
assert they agree within tolerance — this catches differentiation bugs that
exact-match tests on complex expressions might miss due to equivalent-but-
differently-shaped output.

### M5.2 — Simplification
Rewrite rules, fixed-point application, exact constant folding. This is the
one that needs the most test discipline — simplification bugs are silent and
compound (an over-eager rule can silently produce a wrong-but-plausible
result). Write the property test before the rules: for a battery of random
expressions, `evaluate(original) ≈ evaluate(simplify(original))` at several
random points — this is a correctness invariant simplify can never violate,
independent of which specific rules exist.

**Accept:** the property test above passes on ≥500 randomly generated
expressions; a curated list of known simplifications (`2x+3x → 5x`,
`sin(x)^2+cos(x)^2 → 1`, `x/x → 1` with the x≠0 caveat noted, etc.) passes
exactly.

### M5.3 — Equation solving
Linear and quadratic exact solving (complex-aware — `x^2+1=0` should return
`±i`, or clearly say complex results aren't displayed if you scope complex
numbers out of v1, your call). Newton's method with bisection fallback for
everything else, with sane initial-guess heuristics (sample the function
across a range, bracket sign changes).

**Accept:** exact cases match hand-verified answers; numeric solver finds all
real roots of a battery of test functions (including ones with multiple
roots) within tolerance; `no-solution-found` is distinguished from
`kind: 'exact', solutions: []`.

### M5.4 — Integration (indefinite pattern table + definite)
Build the pattern table incrementally — start with ~30 core forms (power
rule, 1/x, eˣ, basic trig), verify, then expand. u-substitution: detect a
handful of recognizable composite shapes (`f'(x)·g(f(x))` for g in the known
table) rather than attempting general substitution search.

**Accept:** every pattern-table entry differentiates back to its integrand
(this is a cheap, powerful correctness check — reuses M5.1's differentiate());
definite integration matches known closed-form values where available and
matches Simpson's-rule numeric answers elsewhere within tolerance.

### M5.5 — Limits + engine wiring
L'Hôpital via the differentiation engine for `0/0` and `∞/∞` forms (with a
recursion cap — repeated L'Hôpital can loop on pathological input). Wire
`CasEngine`, inline syntax, and the right-click menu per the original spec.

**Accept:** standard limit battery (including classic indeterminate forms)
passes; inline `derivative(...)`/menu path and direct `differentiate()` call
produce identical results (they should be the same code path — test that
they are).

## What this buys you for the portfolio/grad-school angle

Worth stating explicitly since it's part of why you're doing this: the
property-testing approach here (numeric cross-check against symbolic results)
is a real, citable technique, not busywork — it's the same idea as how you'd
sanity-check any symbolic-math code, including your own arc-asymmetry
research's CAS-based SageMath work. A CONTRIBUTING.md and test suite built
around "every symbolic operation has a numeric cross-check" is a clean,
explainable design decision in an interview.
