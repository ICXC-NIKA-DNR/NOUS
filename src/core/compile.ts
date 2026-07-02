// compile(ast): (env) => number — the plot hot path ("compile, don't
// interpret", see CLAUDE.md). Emits one JS closure per AST node so sampling a
// curve costs closure calls, not switch dispatch + Map lookups.
//
// The recursive evaluator (evaluator.ts) is the correctness oracle: the
// property tests in __tests__/compile.test.ts pit the two against each other.
// Semantics match, with one deliberate exception: an undefined variable at
// call time returns NaN (a gap) instead of throwing — the caller is expected
// to have validated free variables against the defined sliders up front.
//
// Builtin semantics are NOT duplicated here: closures call the same Builtin
// implementations from evaluator.ts through a per-node scratch-args array
// (reused, so the hot path never allocates). Angle mode is baked in at
// compile time; toggling it recompiles (rare and cheap).
//
// Not supported: user-defined functions (the M3 UI has no way to create
// them). compile throws the evaluator's own diagnostics for unknown
// functions, wrong arity, and non-value nodes at compile time instead of
// per-sample.

import type { Expr, Relation } from './ast.ts';
import { fail, nearestName } from './errors.ts';
import {
  BUILTINS,
  EQ_EPS,
  factorial,
  makeContext,
  type AngleMode,
  type EvalContext,
} from './evaluator.ts';
import { CONSTANTS, FUNCTION_NAMES } from './names.ts';

/** Mutable variable environment. `x` is written per sample by the plot loop. */
export type Env = Record<string, number>;

export type CompiledFn = (env: Env) => number;

export interface CompileOptions {
  angleMode: AngleMode;
}

export function compile(node: Expr, options: CompileOptions): CompiledFn {
  // One shared context per compilation: only angleMode matters to builtins.
  const ctx = makeContext({ angleMode: options.angleMode });
  return compileExpr(node, ctx);
}

function compileExpr(node: Expr, ctx: EvalContext): CompiledFn {
  switch (node.kind) {
    case 'num': {
      const v = node.value;
      return () => v;
    }

    case 'ident': {
      const name = node.name;
      if (name in CONSTANTS) {
        // Evaluator checks variables first, constants second — same here, so
        // a slider named e.g. `e` shadows the constant identically.
        const constant = CONSTANTS[name];
        return (env) => {
          const v = env[name];
          return v !== undefined ? v : constant;
        };
      }
      return (env) => {
        const v = env[name];
        return v !== undefined ? v : NaN; // gap, not throw (see header)
      };
    }

    case 'unary': {
      const operand = compileExpr(node.operand, ctx);
      return node.op === '-' ? (env) => -operand(env) : operand;
    }

    case 'binary': {
      const l = compileExpr(node.left, ctx);
      const r = compileExpr(node.right, ctx);
      switch (node.op) {
        case '+':
          return (env) => l(env) + r(env);
        case '-':
          return (env) => l(env) - r(env);
        case '*':
          return (env) => l(env) * r(env);
        case '/':
          return (env) => l(env) / r(env);
        case '^':
          return (env) => Math.pow(l(env), r(env));
      }
      break; // unreachable
    }

    case 'postfix': {
      const operand = compileExpr(node.operand, ctx);
      return (env) => factorial(operand(env));
    }

    case 'call': {
      const builtin = BUILTINS.get(node.callee);
      if (!builtin) {
        const guess = nearestName(node.callee, FUNCTION_NAMES);
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
      const args = node.args.map((a) => compileExpr(a, ctx));
      // Reused scratch array: zero allocation per call.
      const scratch = new Array<number>(args.length);
      const apply = builtin.apply;
      if (args.length === 1) {
        const a0 = args[0];
        return (env) => {
          scratch[0] = a0(env);
          return apply(scratch, ctx);
        };
      }
      return (env) => {
        for (let i = 0; i < args.length; i++) scratch[i] = args[i](env);
        return apply(scratch, ctx);
      };
    }

    case 'relation':
      fail({
        kind: 'not-a-value',
        message: 'This is a relation, not a value.',
        span: node.span,
      });
      break; // unreachable

    case 'restriction': {
      const body = compileExpr(node.body, ctx);
      const conds = node.conditions.map((c) => compileCondition(c, ctx));
      if (conds.length === 1) {
        const c0 = conds[0];
        return (env) => (c0(env) ? body(env) : NaN);
      }
      return (env) => {
        for (const cond of conds) {
          if (!cond(env)) return NaN;
        }
        return body(env);
      };
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

/** Compiled counterpart of evaluateCondition (same chaining, same epsilon). */
export function compileCondition(
  rel: Relation,
  ctx: EvalContext,
): (env: Env) => boolean {
  const operands = rel.operands.map((o) => compileExpr(o, ctx));
  const ops = rel.ops;
  return (env) => {
    let left = operands[0](env);
    for (let i = 0; i < ops.length; i++) {
      const right = operands[i + 1](env);
      switch (ops[i]) {
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
  };
}
