// Symbolic differentiation (CAS_SPEC.md M5.1). Structural recursion over the
// AST, deliberately mirroring evaluate()'s shape in evaluator.ts — one case
// per node kind — so a reader who understands one recognizes the other.
//
// Semantics notes:
// * Radian semantics throughout: d/dx sin(x) = cos(x). The CAS layer is
//   angle-mode-agnostic by design (degree-mode derivatives would smear
//   π/180 factors over every result); the engine surfaces this honestly.
// * Identifiers other than the differentiation variable are treated as
//   constants (sliders are constants w.r.t. x).
// * abs/floor/ceil/round/sign differentiate almost-everywhere: |u|' =
//   sign(u)·u′; the step functions have derivative 0 wherever they are
//   differentiable. Standard graphing-CAS convention.
// * min/max/mod/gcd/lcm and factorial raise 'cas-unsupported' — honesty over
//   a wrong answer.
//
// Results are passed through simplify() so 1·f′ + 0·g noise never escapes.

import type { Expr } from '../core/ast.ts';
import { fail } from '../core/errors.ts';
import { asRational, add, call, div, mul, neg, num, pow, simplify, sub } from './simplify.ts';

/** d(expr)/d(wrt), simplified. Throws GcalcError('cas-unsupported') for
 * node kinds/functions with no derivative rule. */
export function differentiate(expr: Expr, wrt: string): Expr {
  return simplify(d(expr, wrt));
}

function unsupported(what: string, expr: Expr): never {
  fail({
    kind: 'cas-unsupported',
    message: `Can't differentiate ${what}.`,
    span: expr.span,
  });
}

function d(e: Expr, x: string): Expr {
  switch (e.kind) {
    case 'num':
      return num(0);

    case 'ident':
      // pi/e/etc. are constants; so is every non-x identifier (sliders).
      return e.name === x ? num(1) : num(0);

    case 'unary':
      return e.op === '-' ? neg(d(e.operand, x)) : d(e.operand, x);

    case 'binary': {
      const { left: f, right: g } = e;
      const df = (): Expr => d(f, x);
      const dg = (): Expr => d(g, x);
      switch (e.op) {
        case '+':
          return add(df(), dg());
        case '-':
          return sub(df(), dg());
        case '*':
          // product rule
          return add(mul(df(), g), mul(f, dg()));
        case '/':
          // quotient rule
          return div(sub(mul(df(), g), mul(f, dg())), pow(g, num(2)));
        case '^': {
          const gConst = asRational(g) !== null || isConstantIn(g, x);
          const fConst = asRational(f) !== null || isConstantIn(f, x);
          if (gConst) {
            // d[f^c] = c·f^(c−1)·f′  (holds for any constant c, incl. non-integer)
            return mul(mul(g, pow(f, sub(g, num(1)))), df());
          }
          if (fConst) {
            // d[c^g] = c^g·ln(c)·g′
            return mul(mul(pow(f, g), call('ln', f)), dg());
          }
          // General f^g: logarithmic differentiation —
          // d[f^g] = f^g·(g′·ln f + g·f′/f)
          return mul(pow(f, g), add(mul(dg(), call('ln', f)), div(mul(g, df()), f)));
        }
      }
      break; // unreachable
    }

    case 'postfix':
      return unsupported('a factorial', e);

    case 'call': {
      if (e.args.length !== 1) {
        return unsupported(`${e.callee} of ${e.args.length} arguments`, e);
      }
      const u = e.args[0];
      const du = d(u, x);
      const outer = DERIVATIVES[e.callee];
      if (outer === undefined) return unsupported(`${e.callee}(…)`, e);
      // chain rule: (g∘u)′ = g′(u)·u′
      return mul(outer(u), du);
    }

    case 'relation':
      return unsupported('a relation', e);

    case 'restriction':
      // d/dx of a restricted expression is the restricted derivative.
      return { ...e, body: d(e.body, x) };

    case 'piecewise':
      // Differentiate branch-wise (valid on each branch's open region).
      return {
        ...e,
        branches: e.branches.map((b) => ({ condition: b.condition, value: d(b.value, x) })),
        fallback: e.fallback ? d(e.fallback, x) : undefined,
      };

    case 'point':
    case 'list':
      return unsupported(e.kind === 'point' ? 'a point' : 'a list', e);
  }
}

/** true when `e` contains no occurrence of the variable. */
function isConstantIn(e: Expr, x: string): boolean {
  switch (e.kind) {
    case 'num':
      return true;
    case 'ident':
      return e.name !== x;
    case 'unary':
      return isConstantIn(e.operand, x);
    case 'binary':
      return isConstantIn(e.left, x) && isConstantIn(e.right, x);
    case 'postfix':
      return isConstantIn(e.operand, x);
    case 'call':
      return e.args.every((a) => isConstantIn(a, x));
    case 'relation':
      return e.operands.every((o) => isConstantIn(o, x));
    case 'restriction':
      return isConstantIn(e.body, x) && e.conditions.every((c) => isConstantIn(c, x));
    case 'piecewise':
      return (
        e.branches.every((b) => isConstantIn(b.condition, x) && isConstantIn(b.value, x)) &&
        (e.fallback === undefined || isConstantIn(e.fallback, x))
      );
    case 'point':
      return isConstantIn(e.x, x) && isConstantIn(e.y, x);
    case 'list':
      return e.items.every((i) => isConstantIn(i, x));
  }
}

/**
 * Outer derivatives g′(u) for every differentiable builtin in evaluator.ts's
 * BUILTINS map (chain rule multiplies by u′ at the call site). Everything in
 * BUILTINS is either here or intentionally rejected in d() — the test suite
 * asserts exact coverage against the real map.
 */
const DERIVATIVES: Record<string, (u: Expr) => Expr> = {
  sin: (u) => call('cos', u),
  cos: (u) => neg(call('sin', u)),
  tan: (u) => div(num(1), pow(call('cos', u), num(2))),
  sec: (u) => mul(call('sec', u), call('tan', u)),
  csc: (u) => neg(mul(call('csc', u), call('cot', u))),
  cot: (u) => neg(div(num(1), pow(call('sin', u), num(2)))),
  asin: (u) => div(num(1), call('sqrt', sub(num(1), pow(u, num(2))))),
  acos: (u) => neg(div(num(1), call('sqrt', sub(num(1), pow(u, num(2)))))),
  atan: (u) => div(num(1), add(num(1), pow(u, num(2)))),
  arcsin: (u) => DERIVATIVES.asin(u),
  arccos: (u) => DERIVATIVES.acos(u),
  arctan: (u) => DERIVATIVES.atan(u),
  sinh: (u) => call('cosh', u),
  cosh: (u) => call('sinh', u),
  tanh: (u) => sub(num(1), pow(call('tanh', u), num(2))),
  asinh: (u) => div(num(1), call('sqrt', add(pow(u, num(2)), num(1)))),
  acosh: (u) => div(num(1), call('sqrt', sub(pow(u, num(2)), num(1)))),
  atanh: (u) => div(num(1), sub(num(1), pow(u, num(2)))),
  exp: (u) => call('exp', u),
  ln: (u) => div(num(1), u),
  log: (u) => div(num(1), mul(u, call('ln', num(10)))),
  log2: (u) => div(num(1), mul(u, call('ln', num(2)))),
  sqrt: (u) => div(num(1), mul(num(2), call('sqrt', u))),
  cbrt: (u) => div(num(1), mul(num(3), pow(call('cbrt', u), num(2)))),
  abs: (u) => call('sign', u), // a.e.
  floor: () => num(0), // a.e.
  ceil: () => num(0), // a.e.
  round: () => num(0), // a.e.
  sign: () => num(0), // a.e.
};
