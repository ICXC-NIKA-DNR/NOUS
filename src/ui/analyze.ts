// Adapter between raw sidebar input and the core. Parses a line, classifies
// what it means for M2 (explicit y = f(x) plot, bare f(x) plot, constant
// value, or not-yet-supported), and builds the evaluation closure the plot
// layer samples. Core stays DOM-free; this file stays React-free.

import type { Expr, Relation, Restriction } from '../core/ast.ts';
import { GcalcError, type Diagnostic, type Edit } from '../core/errors.ts';
import { evaluate, makeContext, type AngleMode } from '../core/evaluator.ts';
import { CONSTANTS } from '../core/names.ts';
import { parse } from '../core/parser.ts';

export type Analysis =
  | { kind: 'empty' }
  | { kind: 'error'; diagnostic: Diagnostic }
  | { kind: 'plot'; ast: Expr; f: (x: number) => number }
  | { kind: 'value'; ast: Expr; value: number }
  | { kind: 'unsupported'; ast: Expr; reason: string };

/** Free variables: identifiers that are neither constants nor call targets. */
export function freeVars(node: Expr, out = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'num':
      break;
    case 'ident':
      if (!(node.name in CONSTANTS)) out.add(node.name);
      break;
    case 'unary':
      freeVars(node.operand, out);
      break;
    case 'binary':
      freeVars(node.left, out);
      freeVars(node.right, out);
      break;
    case 'postfix':
      freeVars(node.operand, out);
      break;
    case 'call':
      for (const a of node.args) freeVars(a, out);
      break;
    case 'relation':
      for (const o of node.operands) freeVars(o, out);
      break;
    case 'restriction':
      freeVars(node.body, out);
      for (const c of node.conditions) freeVars(c, out);
      break;
    case 'point':
      freeVars(node.x, out);
      freeVars(node.y, out);
      break;
    case 'list':
      for (const i of node.items) freeVars(i, out);
      break;
  }
  return out;
}

/** `y = rhs` / `lhs = y` with the other side free of y → that side, else null. */
function explicitBody(rel: Relation): Expr | null {
  if (rel.ops.length !== 1 || rel.ops[0] !== '=') return null;
  const [a, b] = rel.operands;
  const aIsY = a.kind === 'ident' && a.name === 'y';
  const bIsY = b.kind === 'ident' && b.name === 'y';
  if (aIsY && !freeVars(b).has('y')) return b;
  if (bIsY && !freeVars(a).has('y')) return a;
  return null;
}

function makeF(body: Expr, angleMode: AngleMode): (x: number) => number {
  // One mutable env shared across samples; M3 replaces this with compile().
  const vars = new Map<string, number>([['x', 0]]);
  const ctx = makeContext({ angleMode, variables: vars });
  return (x: number): number => {
    vars.set('x', x);
    try {
      return evaluate(body, ctx);
    } catch {
      return NaN;
    }
  };
}

export function analyze(source: string, angleMode: AngleMode): Analysis {
  if (source.trim() === '') return { kind: 'empty' };

  let ast: Expr;
  try {
    ast = parse(source);
  } catch (e) {
    if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
    throw e;
  }

  // Unwrap a trailing domain restriction; re-attach it to the plotted body so
  // failed conditions become NaN gaps.
  let core: Expr = ast;
  let restriction: Restriction | null = null;
  if (core.kind === 'restriction') {
    restriction = core;
    core = core.body;
  }

  const withRestriction = (body: Expr): Expr =>
    restriction ? { ...restriction, body } : body;

  if (core.kind === 'relation') {
    const body = explicitBody(core);
    if (body !== null) {
      const vars = freeVars(withRestriction(body));
      vars.delete('x');
      if (vars.size > 0) {
        return unknownVariable(ast, vars);
      }
      return { kind: 'plot', ast, f: makeF(withRestriction(body), angleMode) };
    }
    return {
      kind: 'unsupported',
      ast,
      reason: 'Implicit equations and inequalities arrive in M4.',
    };
  }

  if (core.kind === 'point' || core.kind === 'list') {
    return { kind: 'unsupported', ast, reason: 'Points and lists plot in M4.' };
  }

  const vars = freeVars(withRestriction(core));
  if (vars.size === 0 && !restriction) {
    try {
      const ctx = makeContext({ angleMode });
      return { kind: 'value', ast, value: evaluate(core, ctx) };
    } catch (e) {
      if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
      throw e;
    }
  }

  vars.delete('x');
  if (vars.size > 0) return unknownVariable(ast, vars);

  // Bare expression in x → treat as y = expr, Desmos-style.
  return { kind: 'plot', ast, f: makeF(withRestriction(core), angleMode) };
}

function unknownVariable(ast: Expr, vars: Set<string>): Analysis {
  const name = [...vars][0];
  return {
    kind: 'error',
    diagnostic: {
      kind: 'undefined-variable',
      message: `"${name}" is not defined.`,
      span: ast.span,
      suggestion: {
        label: `Add a slider for ${name} (M3)`,
        action: 'create-slider',
        name,
      },
    },
  };
}

/** Apply a machine suggestion edit to the source text. */
export function applyEdit(source: string, edit: Edit): string {
  if (edit.type === 'insert') {
    return source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  }
  return source.slice(0, edit.span.start) + edit.text + source.slice(edit.span.end);
}

/** Display formatting for numeric results (precision becomes a setting in M5). */
export function formatValue(value: number, sigDigits = 6): string {
  if (Number.isNaN(value)) return 'undefined';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const s = value.toPrecision(sigDigits);
  return s.includes('e') ? s : s.replace(/\.?0+$/, '');
}
