// CasEngine (CLAUDE.md architecture / CAS_SPEC.md M5.5): the single
// interface every consumer routes through — the sidebar's CAS menu, the
// inline derivative(...)/integral(...) syntax, and any future caller. There
// is exactly one code path per operation; the tests assert the inline
// syntax and a direct engine call produce identical trees.
//
// The engine is angle-mode-agnostic: symbolic operations use radian
// semantics throughout (see differentiate.ts). Exact results are ASTs;
// approximations are produced on demand at the caller's display precision.

import type { Expr, Relation } from '../core/ast.ts';
import { evaluate, makeContext } from '../core/evaluator.ts';
import { differentiate } from './differentiate.ts';
import { integrate, integrateDefinite } from './integrate.ts';
import { limit, type Approach, type LimitResult, type Side } from './limit.ts';
import { factor, solve, type SolveResult } from './solve.ts';
import { simplify } from './simplify.ts';

export interface CasEngine {
  simplify(expr: Expr): Expr;
  factor(expr: Expr, wrt?: string): Expr;
  differentiate(expr: Expr, wrt?: string): Expr;
  /** Indefinite; null = no closed form found (an honest answer). */
  integrate(expr: Expr, wrt?: string): Expr | null;
  integrateDefinite(expr: Expr, wrt: string, a: number, b: number): number;
  solve(equation: Relation, wrt?: string): SolveResult;
  limit(expr: Expr, wrt: string, approaching: Approach, side?: Side): LimitResult;
  /** Numeric value of a closed expression — the "approximate" half of
   * every exact result. NaN when evaluation fails. */
  approximate(expr: Expr): number;
}

export const engine: CasEngine = {
  simplify,
  factor: (expr, wrt = 'x') => factor(expr, wrt),
  differentiate: (expr, wrt = 'x') => differentiate(expr, wrt),
  integrate: (expr, wrt = 'x') => integrate(expr, wrt),
  integrateDefinite,
  solve: (equation, wrt = 'x') => solve(equation, wrt),
  limit,
  approximate: (expr) => {
    try {
      return evaluate(expr, makeContext());
    } catch {
      return NaN;
    }
  },
};
