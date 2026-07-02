// Reference numeric evaluator. This is the correctness oracle: the compiled
// hot-path evaluator added in M3 must agree with this one (property-test them
// against each other). Deliberately simple and readable.
//
// Semantics notes:
// * Undefined variables throw a structured error carrying a 'create-slider'
//   suggestion — that error is how the UI knows to offer a slider.
// * Restrictions evaluate to NaN when a condition fails (NaN = "gap" to the
//   plotting layer).
// * IEEE behavior is kept: 1/0 = Infinity, 0/0 = NaN. The plotter wants this.
// * Angle mode converts inputs of trig functions and outputs of inverse trig.
//   Hyperbolic functions are never converted.

import type { Expr, Relation } from './ast.ts';
import { fail, nearestName } from './errors.ts';
import { CONSTANTS, FUNCTION_NAMES } from './names.ts';

export type AngleMode = 'radians' | 'degrees';

export interface UserFunction {
  params: string[];
  body: Expr;
}

export interface EvalContext {
  angleMode: AngleMode;
  variables: ReadonlyMap<string, number>;
  functions: ReadonlyMap<string, UserFunction>;
}

export function makeContext(partial: Partial<EvalContext> = {}): EvalContext {
  return {
    angleMode: partial.angleMode ?? 'radians',
    variables: partial.variables ?? new Map(),
    functions: partial.functions ?? new Map(),
  };
}

const DEG = Math.PI / 180;

interface Builtin {
  minArity: number;
  maxArity: number;
  apply(args: number[], ctx: EvalContext): number;
}

const trig = (f: (x: number) => number): Builtin => ({
  minArity: 1,
  maxArity: 1,
  apply: ([x], ctx) => f(ctx.angleMode === 'degrees' ? x * DEG : x),
});

const atrig = (f: (x: number) => number): Builtin => ({
  minArity: 1,
  maxArity: 1,
  apply: ([x], ctx) => {
    const r = f(x);
    return ctx.angleMode === 'degrees' ? r / DEG : r;
  },
});

const plain = (f: (...xs: number[]) => number, minArity = 1, maxArity = minArity): Builtin => ({
  minArity,
  maxArity,
  apply: (args) => f(...args),
});

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) return NaN; // Gamma extension: future work
  if (n > 170) return Infinity;
  let acc = 1;
  for (let k = 2; k <= n; k++) acc *= k;
  return acc;
}

function gcd2(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export const BUILTINS: ReadonlyMap<string, Builtin> = new Map<string, Builtin>([
  ['sin', trig(Math.sin)],
  ['cos', trig(Math.cos)],
  ['tan', trig(Math.tan)],
  ['sec', trig((x) => 1 / Math.cos(x))],
  ['csc', trig((x) => 1 / Math.sin(x))],
  ['cot', trig((x) => Math.cos(x) / Math.sin(x))],
  ['asin', atrig(Math.asin)],
  ['acos', atrig(Math.acos)],
  ['atan', atrig(Math.atan)],
  ['arcsin', atrig(Math.asin)],
  ['arccos', atrig(Math.acos)],
  ['arctan', atrig(Math.atan)],
  ['sinh', plain(Math.sinh)],
  ['cosh', plain(Math.cosh)],
  ['tanh', plain(Math.tanh)],
  ['asinh', plain(Math.asinh)],
  ['acosh', plain(Math.acosh)],
  ['atanh', plain(Math.atanh)],
  ['exp', plain(Math.exp)],
  ['ln', plain(Math.log)],
  ['log', plain(Math.log10)],
  ['log2', plain(Math.log2)],
  ['sqrt', plain(Math.sqrt)],
  ['cbrt', plain(Math.cbrt)],
  ['abs', plain(Math.abs)],
  ['floor', plain(Math.floor)],
  ['ceil', plain(Math.ceil)],
  ['round', plain(Math.round)],
  ['sign', plain(Math.sign)],
  ['min', plain(Math.min, 1, Infinity)],
  ['max', plain(Math.max, 1, Infinity)],
  ['mod', plain((a, b) => ((a % b) + b) % b, 2)], // mathematician's mod
  ['gcd', plain(gcd2, 2)],
  ['lcm', plain((a, b) => (a === 0 && b === 0 ? 0 : Math.abs(a * b) / gcd2(a, b)), 2)],
]);

/* ------------------------------------------------------------------ */

export function evaluate(node: Expr, ctx: EvalContext): number {
  switch (node.kind) {
    case 'num':
      return node.value;

    case 'ident': {
      const fromVars = ctx.variables.get(node.name);
      if (fromVars !== undefined) return fromVars;
      if (node.name in CONSTANTS) return CONSTANTS[node.name];
      fail({
        kind: 'undefined-variable',
        message: `"${node.name}" is not defined.`,
        span: node.span,
        suggestion: {
          label: `Add a slider for ${node.name}`,
          action: 'create-slider',
          name: node.name,
        },
      });
      break; // unreachable
    }

    case 'unary': {
      const v = evaluate(node.operand, ctx);
      return node.op === '-' ? -v : v;
    }

    case 'binary': {
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '^':
          return Math.pow(l, r);
      }
      break; // unreachable
    }

    case 'postfix':
      return factorial(evaluate(node.operand, ctx));

    case 'call': {
      const user = ctx.functions.get(node.callee);
      if (user) {
        if (node.args.length !== user.params.length) {
          fail({
            kind: 'wrong-arity',
            message: `${node.callee} takes ${user.params.length} argument${user.params.length === 1 ? '' : 's'}, got ${node.args.length}.`,
            span: node.span,
          });
        }
        const inner = new Map(ctx.variables);
        user.params.forEach((p, i) => inner.set(p, evaluate(node.args[i], ctx)));
        return evaluate(user.body, { ...ctx, variables: inner });
      }

      const builtin = BUILTINS.get(node.callee);
      if (!builtin) {
        const guess = nearestName(node.callee, [...FUNCTION_NAMES, ...ctx.functions.keys()]);
        fail({
          kind: 'unknown-function',
          message: `"${node.callee}" isn't a function.`,
          span: node.span,
          suggestion: guess
            ? { label: `Did you mean ${guess}?`, edit: { type: 'replace', span: node.span, text: guess } }
            : undefined,
        });
      }
      if (node.args.length < builtin.minArity || node.args.length > builtin.maxArity) {
        const want =
          builtin.minArity === builtin.maxArity
            ? String(builtin.minArity)
            : builtin.maxArity === Infinity
              ? `at least ${builtin.minArity}`
              : `${builtin.minArity}–${builtin.maxArity}`;
        fail({
          kind: 'wrong-arity',
          message: `${node.callee} takes ${want} argument${want === '1' ? '' : 's'}, got ${node.args.length}.`,
          span: node.span,
        });
      }
      return builtin.apply(node.args.map((a) => evaluate(a, ctx)), ctx);
    }

    case 'relation':
      fail({
        kind: 'not-a-value',
        message: 'This is a relation, not a value. (Use evaluateCondition for conditions.)',
        span: node.span,
      });
      break; // unreachable

    case 'restriction': {
      for (const cond of node.conditions) {
        if (!evaluateCondition(cond, ctx)) return NaN; // NaN = gap, for the plotter
      }
      return evaluate(node.body, ctx);
    }

    case 'point':
    case 'list':
      fail({
        kind: 'not-a-value',
        message:
          node.kind === 'point'
            ? 'A point is not a single number.'
            : 'A list is not a single number.',
        span: node.span,
      });
  }
}

const EQ_EPS = 1e-9;

/** Evaluate a (possibly chained) relation as a boolean condition. */
export function evaluateCondition(rel: Relation, ctx: EvalContext): boolean {
  let left = evaluate(rel.operands[0], ctx);
  for (let i = 0; i < rel.ops.length; i++) {
    const right = evaluate(rel.operands[i + 1], ctx);
    switch (rel.ops[i]) {
      case '<':
        if (!(left < right)) return false;
        break;
      case '<=':
        if (!(left <= right)) return false;
        break;
      case '>':
        if (!(left > right)) return false;
        break;
      case '>=':
        if (!(left >= right)) return false;
        break;
      case '=':
        if (!(Math.abs(left - right) <= EQ_EPS)) return false;
        break;
    }
    left = right;
  }
  return true;
}
