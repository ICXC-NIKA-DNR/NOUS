// User-function inlining + cycle detection (M9.5.2). The plot hot path
// ("compile, don't interpret") has no notion of user functions; rather than
// teach compile.ts about them, we rewrite user calls into their bodies BEFORE
// compiling — substituting argument ASTs for parameters, expandCas-style. The
// result is a plain expression the existing compiler and evaluator already
// handle, so both stay unchanged and stay in agreement.
//
// Substitution is capture-safe by construction: the only bound names in this
// language are function parameters, and inlining replaces every parameter
// occurrence in one pass (simultaneously, so `f(b, a)` with `f(a,b)=…` swaps
// correctly). Slider/global names resolve in the shared env either way.
//
// Recursion is impossible to inline (it never terminates), so callers detect
// cycles first and mark those names unusable; inlineFunctions refuses to touch
// a call to a marked name and raises a structured error instead of looping.

import type { Expr } from './ast.ts';
import { fail } from './errors.ts';
import type { UserFunction } from './evaluator.ts';

/** Names a user-function body references that are themselves user functions. */
function referencedFunctions(body: Expr, names: ReadonlySet<string>, out = new Set<string>()): Set<string> {
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'num':
      case 'ident':
        break;
      case 'unary':
      case 'postfix':
        walk(e.operand);
        break;
      case 'binary':
        walk(e.left);
        walk(e.right);
        break;
      case 'call':
        if (names.has(e.callee)) out.add(e.callee);
        for (const a of e.args) walk(a);
        break;
      case 'relation':
        for (const o of e.operands) walk(o);
        break;
      case 'restriction':
        walk(e.body);
        for (const c of e.conditions) walk(c);
        break;
      case 'piecewise':
        for (const b of e.branches) {
          walk(b.condition);
          walk(b.value);
        }
        if (e.fallback) walk(e.fallback);
        break;
      case 'point':
        walk(e.x);
        walk(e.y);
        break;
      case 'list':
        for (const i of e.items) walk(i);
        break;
    }
  };
  walk(body);
  return out;
}

/**
 * Names that lie on a definition cycle (direct `f→f` or mutual `f→g→f`).
 * Tarjan-free: a name is cyclic iff it can reach itself in the call graph.
 */
export function detectFunctionCycles(
  functions: ReadonlyMap<string, UserFunction>,
): Set<string> {
  const names = new Set(functions.keys());
  const edges = new Map<string, Set<string>>();
  for (const [name, fn] of functions) {
    edges.set(name, referencedFunctions(fn.body, names));
  }

  const cyclic = new Set<string>();
  for (const start of names) {
    // Can `start` reach itself?
    const stack = [...(edges.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === start) {
        cyclic.add(start);
        break;
      }
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of edges.get(n) ?? []) stack.push(m);
    }
  }
  return cyclic;
}

/** Replace `params` with `args` throughout `body`, in a single pass. */
function substitute(body: Expr, subst: ReadonlyMap<string, Expr>): Expr {
  const go = (e: Expr): Expr => {
    switch (e.kind) {
      case 'num':
        return e;
      case 'ident':
        return subst.get(e.name) ?? e;
      case 'unary':
        return { ...e, operand: go(e.operand) };
      case 'postfix':
        return { ...e, operand: go(e.operand) };
      case 'binary':
        return { ...e, left: go(e.left), right: go(e.right) };
      case 'call':
        return { ...e, args: e.args.map(go) };
      case 'relation':
        return { ...e, operands: e.operands.map(go) };
      case 'restriction':
        return {
          ...e,
          body: go(e.body),
          conditions: e.conditions.map((c) => go(c) as typeof c),
        };
      case 'piecewise':
        return {
          ...e,
          branches: e.branches.map((b) => ({
            condition: go(b.condition) as typeof b.condition,
            value: go(b.value),
          })),
          fallback: e.fallback ? go(e.fallback) : undefined,
        };
      case 'point':
        return { ...e, x: go(e.x), y: go(e.y) };
      case 'list':
        return { ...e, items: e.items.map(go) };
    }
  };
  return go(body);
}

/**
 * Rewrite every user-function call in `expr` into its (recursively inlined)
 * body. `invalid` maps unusable names (cyclic / ambiguous) to the error shown
 * when they're called. Builtins and non-function idents are left untouched.
 */
export function inlineFunctions(
  expr: Expr,
  functions: ReadonlyMap<string, UserFunction>,
  invalid: ReadonlyMap<string, string> = new Map(),
): Expr {
  const go = (e: Expr): Expr => {
    switch (e.kind) {
      case 'num':
      case 'ident':
        return e;
      case 'unary':
        return { ...e, operand: go(e.operand) };
      case 'postfix':
        return { ...e, operand: go(e.operand) };
      case 'binary':
        return { ...e, left: go(e.left), right: go(e.right) };
      case 'call': {
        const args = e.args.map(go);
        const invalidReason = invalid.get(e.callee);
        if (invalidReason !== undefined) {
          fail({ kind: 'cas-unsupported', message: invalidReason, span: e.span });
        }
        const fn = functions.get(e.callee);
        if (fn === undefined) return { ...e, args }; // builtin or plain unknown
        if (args.length !== fn.params.length) {
          fail({
            kind: 'wrong-arity',
            message: `${e.callee} takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}, got ${args.length}.`,
            span: e.span,
          });
        }
        const subst = new Map<string, Expr>();
        fn.params.forEach((p, i) => subst.set(p, args[i]));
        // Recurse into the substituted body to resolve nested user calls.
        // Terminates because `functions` is acyclic (cycles are in `invalid`).
        return go(substitute(fn.body, subst));
      }
      case 'relation':
        return { ...e, operands: e.operands.map(go) };
      case 'restriction':
        return {
          ...e,
          body: go(e.body),
          conditions: e.conditions.map((c) => go(c) as typeof c),
        };
      case 'piecewise':
        return {
          ...e,
          branches: e.branches.map((b) => ({
            condition: go(b.condition) as typeof b.condition,
            value: go(b.value),
          })),
          fallback: e.fallback ? go(e.fallback) : undefined,
        };
      case 'point':
        return { ...e, x: go(e.x), y: go(e.y) };
      case 'list':
        return { ...e, items: e.items.map(go) };
    }
  };
  return go(expr);
}
