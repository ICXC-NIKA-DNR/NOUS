Before writing any code, read three files in this order: CLAUDE.md, PLAN.md,
and CAS_SPEC.md. CAS_SPEC.md supersedes the CAS section of CLAUDE.md/PLAN.md's
original M5 — it replaces the Giac-WASM approach with a from-scratch,
MIT-licensed symbolic engine, for a documented reason: Giac is GPL-3.0, which
conflicts with this project's MIT license, and no permissively-licensed CAS
library fit the Rust/WASM stack well enough to justify the dependency. This
was a deliberate scoping decision, not a shortcut — treat CAS_SPEC.md as
authoritative for everything M5.

**Step 1 — audit, don't assume.** Some M5 work may already exist in this repo
from before CAS_SPEC.md was written. Check `src/cas/` (or wherever CAS code
currently lives) for:
- Any reference to Giac, GPL, or WASM-based CAS integration — flag these
  explicitly and do not build on top of them. If Giac was partially wired in,
  report exactly what's there so a human can decide whether to remove it now
  or leave it stubbed for later.
- Any existing differentiation/simplification/solving code that's *compatible*
  with CAS_SPEC.md's architecture (AST-native, no external CAS dependency) —
  this can likely be kept and extended rather than rewritten.

Report findings before proceeding to Step 2. Do not silently delete or
silently build on top of anything Giac-related — surface it.

**Step 2 — implement in CAS_SPEC.md's milestone order**, starting from
wherever the audit says is safe to resume (likely M5.1 if no compatible work
exists yet):

- M5.1: `Rational` type (exact bigint arithmetic) + `differentiate()` in
  `src/cas/differentiate.ts`, covering every builtin in `evaluator.ts`'s
  `BUILTINS` map plus sum/product/quotient/chain/power rules.
- M5.2: `simplify()` in `src/cas/simplify.ts` — rewrite rules to a fixed
  point, exact constant folding via `Rational`.
- M5.3: `solve()` in `src/cas/solve.ts` — exact linear/quadratic, numeric
  fallback (Newton + bisection) otherwise, with the `SolveResult` tagged
  union distinguishing exact / numeric / no-solution-found.
- M5.4: `integrate()` / `integrateDefinite()` in `src/cas/integrate.ts` —
  pattern-table indefinite integration, numeric quadrature fallback for
  definite integrals.
- M5.5: `limit()` in `src/cas/limit.ts`, then wire everything through the
  `CasEngine` interface in `src/cas/engine.ts` per CLAUDE.md, plus the inline
  `derivative(...)` syntax and right-click CAS menu.

Follow each milestone's acceptance criteria in CAS_SPEC.md exactly, including
the property-based numeric cross-checks (e.g. central-difference numeric
derivative vs. symbolic derivative agreement; `evaluate(simplify(e)) ≈
evaluate(e)` across random samples; every integration pattern-table entry
differentiates back to its integrand). These cross-checks are the actual
correctness contract for this milestone — don't treat them as optional
polish, and don't mark a sub-milestone done without them passing.

**Step 3 — after each of M5.1 through M5.5**, run the full test suite
(`npm test`) and report pass/fail before moving to the next sub-milestone. Do
not batch all of M5 into one untested pass.

**Step 4 — when M5 is complete**, update README.md's "known limitations"
section (create one if it doesn't exist) to honestly state what's out of
scope per CAS_SPEC.md (general symbolic integration / Risch algorithm,
high-degree symbolic solving, matrix CAS) and why — this is a documented
engineering decision, present it as one, not an apology.

If anything in the existing repo contradicts CAS_SPEC.md in a way that isn't
a simple audit-and-report case — e.g. architectural decisions already baked
in elsewhere that assumed Giac's presence — stop and ask before proceeding
rather than guessing.
