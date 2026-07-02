// Adapter between raw sidebar input and the core. Parses a line, classifies
// it (explicit y = f(x) plot, slider definition, constant value, or
// not-yet-supported), and compiles the evaluation closure the plot layer
// samples. Core stays DOM-free; this file stays React-free.
//
// Plot closures go through core/compile.ts (the hot path); one-off values
// use the recursive evaluator (the cold path).

import type { Expr, Relation, Restriction } from '../core/ast.ts';
import { compile, type Env } from '../core/compile.ts';
import { GcalcError, type Diagnostic, type Edit } from '../core/errors.ts';
import { evaluate, makeContext, type AngleMode } from '../core/evaluator.ts';
import { CONSTANTS, FUNCTION_NAMES } from '../core/names.ts';
import { parse } from '../core/parser.ts';

export type Analysis =
  | { kind: 'empty' }
  | { kind: 'error'; diagnostic: Diagnostic }
  | {
      kind: 'plot';
      ast: Expr;
      /** Sampled by the plot loop; env.x is set per sample. */
      f: (x: number, env: Env) => number;
      /** Defined names this curve reads — the dirty-tracking key. */
      deps: readonly string[];
    }
  | { kind: 'value'; ast: Expr; value: number }
  | {
      kind: 'definition';
      ast: Expr;
      /** Slider name (lhs). */
      name: string;
      /** Current value (rhs evaluated; rhs must be closed). */
      value: number;
    }
  | { kind: 'unsupported'; ast: Expr; reason: string };

const RESERVED = new Set(['x', 'y', ...FUNCTION_NAMES]);

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

/** `name = <closed expr>` with a plain, non-reserved name → the definition. */
function definitionParts(rel: Relation): { name: string; rhs: Expr } | null {
  if (rel.ops.length !== 1 || rel.ops[0] !== '=') return null;
  const [a, b] = rel.operands;
  const pick = (lhs: Expr, rhs: Expr): { name: string; rhs: Expr } | null =>
    lhs.kind === 'ident' &&
    !RESERVED.has(lhs.name) &&
    !(lhs.name in CONSTANTS) &&
    freeVars(rhs).size === 0
      ? { name: lhs.name, rhs }
      : null;
  return pick(a, b) ?? pick(b, a);
}

export function analyze(
  source: string,
  angleMode: AngleMode,
  defined: ReadonlySet<string>,
): Analysis {
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

  const coldCtx = (): ReturnType<typeof makeContext> => makeContext({ angleMode });

  const toPlot = (body: Expr): Analysis => {
    const restricted = withRestriction(body);
    const vars = freeVars(restricted);
    vars.delete('x');
    for (const name of defined) vars.delete(name);
    if (vars.size > 0) return unknownVariable(ast, vars);

    let compiled;
    try {
      compiled = compile(restricted, { angleMode });
    } catch (e) {
      if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
      throw e;
    }
    const deps = [...freeVars(restricted)].filter((n) => n !== 'x').sort();
    const f = (x: number, env: Env): number => {
      env.x = x;
      return compiled(env);
    };
    return { kind: 'plot', ast, f, deps };
  };

  if (core.kind === 'relation') {
    const body = explicitBody(core);
    if (body !== null) return toPlot(body);

    const def = definitionParts(core);
    if (def !== null && !restriction) {
      try {
        return { kind: 'definition', ast, name: def.name, value: evaluate(def.rhs, coldCtx()) };
      } catch (e) {
        if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
        throw e;
      }
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
      return { kind: 'value', ast, value: evaluate(core, coldCtx()) };
    } catch (e) {
      if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
      throw e;
    }
  }

  // Bare expression in x (and sliders) → treat as y = expr, Desmos-style.
  return toPlot(core);
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
        label: `Add a slider for ${name}`,
        action: 'create-slider',
        name,
      },
    },
  };
}

const defNameCache = new Map<string, string | null>();

/**
 * Fast pass-1 classifier: the slider name a line defines, or null. Memoized
 * by source — App calls this for every row on every render.
 */
export function definitionName(source: string): string | null {
  const hit = defNameCache.get(source);
  if (hit !== undefined) return hit;
  if (defNameCache.size > 1000) defNameCache.clear();
  let name: string | null = null;
  try {
    const ast = parse(source);
    if (ast.kind === 'relation') {
      name = definitionParts(ast)?.name ?? null;
    }
  } catch {
    name = null;
  }
  defNameCache.set(source, name);
  return name;
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
