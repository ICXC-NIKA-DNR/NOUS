// Adapter between raw sidebar input and the core. Parses a line, classifies
// it into a typed PlotSpec (explicit, parametric, polar, implicit, region,
// points, vector, field), a slider definition, or a value, and compiles the
// closures the plot layer samples. Core stays DOM-free; this stays React-free.
//
// Sampling variables are reserved per plot type: x (explicit), t
// (parametric), theta (polar), x+y (implicit/region/field). Everything else
// free must be a defined slider — tracked in `deps` for dirty tracking.

import type { Expr, Relation, RelOp, Restriction, Span } from '../core/ast.ts';
import { engine } from '../cas/engine.ts';
import { compile, compileCondition, type CompiledFn, type Env } from '../core/compile.ts';
import { fail, GcalcError, type Diagnostic, type Edit } from '../core/errors.ts';
import {
  evaluate,
  makeContext,
  type AngleMode,
  type EvalContext,
  type UserFunction,
} from '../core/evaluator.ts';
import { scanFunctionHead } from '../core/funcdef.ts';
import { detectFunctionCycles, inlineFunctions } from '../core/inline.ts';
import { CONSTANTS, FUNCTION_NAMES } from '../core/names.ts';
import { parse } from '../core/parser.ts';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type BoundFn = (env: Env) => number;

export type PlotSpec =
  | {
      type: 'explicit';
      f: (x: number, env: Env) => number;
      /** The scalar body AST (restriction included) — the CAS menu's input. */
      body: Expr;
    }
  | {
      type: 'parametric';
      fx: (t: number, env: Env) => number;
      fy: (t: number, env: Env) => number;
      t0: BoundFn;
      t1: BoundFn;
    }
  | {
      type: 'polar';
      fr: (theta: number, env: Env) => number;
      th0: BoundFn;
      th1: BoundFn;
      /** θ → radians conversion for the x/y projection (1 or π/180). */
      toRad: number;
    }
  | { type: 'implicit'; F: (x: number, y: number, env: Env) => number }
  | {
      type: 'region';
      inside: (x: number, y: number, env: Env) => boolean;
      /** Boundary contours F=0, dashed when the adjacent op is strict. */
      boundaries: Array<{ F: (x: number, y: number, env: Env) => number; strict: boolean }>;
    }
  | { type: 'points'; pts: Array<{ fx: CompiledFn; fy: CompiledFn }>; gate: (env: Env) => boolean }
  | {
      type: 'vector';
      from: { fx: CompiledFn; fy: CompiledFn };
      to: { fx: CompiledFn; fy: CompiledFn };
      gate: (env: Env) => boolean;
    }
  | {
      type: 'field';
      P: (x: number, y: number, env: Env) => number;
      Q: (x: number, y: number, env: Env) => number;
    };

export type Analysis =
  | { kind: 'empty' }
  | { kind: 'error'; diagnostic: Diagnostic }
  | { kind: 'plot'; ast: Expr; spec: PlotSpec; deps: readonly string[] }
  | { kind: 'value'; ast: Expr; value: number }
  | { kind: 'definition'; ast: Expr; name: string; value: number }
  | { kind: 'function-definition'; ast: Expr; name: string; params: string[]; body: Expr }
  | { kind: 'unsupported'; ast: Expr; reason: string };

const RESERVED = new Set(['x', 'y', ...FUNCTION_NAMES]);
/** Names a user function may not take: sampling vars, constants, builtins. */
const RESERVED_FUNCTION_NAMES = new Set(['x', 'y', 'r', 'theta', ...FUNCTION_NAMES, ...Object.keys(CONSTANTS)]);

export function isReservedFunctionName(name: string): boolean {
  return RESERVED_FUNCTION_NAMES.has(name);
}
/** Registered so the lexer keeps these words whole. */
const EXTRA_FUNCTIONS = ['vector', 'derivative', 'integral'];

/**
 * Expand inline CAS calls — derivative(f) / derivative(f, t) and
 * integral(f) / integral(f, t) — bottom-up, through the same engine the CAS
 * menu uses (one code path; tested for identity). CAS semantics are
 * radians; errors surface as structured diagnostics.
 */
function expandCas(e: Expr): Expr {
  const walked = mapChildrenExpr(e, expandCas);
  if (walked.kind !== 'call') return walked;
  if (walked.callee !== 'derivative' && walked.callee !== 'integral') return walked;

  const [body, wrtArg] = walked.args;
  if (walked.args.length < 1 || walked.args.length > 2 || (wrtArg && wrtArg.kind !== 'ident')) {
    fail({
      kind: 'cas-unsupported',
      message: `${walked.callee} takes an expression and an optional variable: ${walked.callee}(f, x).`,
      span: walked.span,
    });
  }
  const wrt = wrtArg && wrtArg.kind === 'ident' ? wrtArg.name : 'x';

  if (walked.callee === 'derivative') return engine.differentiate(body, wrt);

  const anti = engine.integrate(body, wrt);
  if (anti === null) {
    fail({
      kind: 'cas-unsupported',
      message: 'No closed-form antiderivative found. (Definite integrals always work numerically.)',
      span: walked.span,
    });
  }
  return anti;
}

function mapChildrenExpr(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'num':
    case 'ident':
      return e;
    case 'unary':
      return { ...e, operand: f(e.operand) };
    case 'binary':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'postfix':
      return { ...e, operand: f(e.operand) };
    case 'call':
      return { ...e, args: e.args.map(f) };
    case 'relation':
      return { ...e, operands: e.operands.map(f) };
    case 'restriction':
      return {
        ...e,
        body: f(e.body),
        conditions: e.conditions.map((c) => f(c) as typeof c),
      };
    case 'piecewise':
      return {
        ...e,
        branches: e.branches.map((b) => ({
          condition: f(b.condition) as typeof b.condition,
          value: f(b.value),
        })),
        fallback: e.fallback ? f(e.fallback) : undefined,
      };
    case 'point':
      return { ...e, x: f(e.x), y: f(e.y) };
    case 'list':
      return { ...e, items: e.items.map(f) };
  }
}

/** Conjunction of restriction conditions as an env predicate. */
function makeGate(conditions: Relation[], angleMode: AngleMode): (env: Env) => boolean {
  if (conditions.length === 0) return () => true;
  const compiled = conditions.map((c) => compileCondition(c, makeContext({ angleMode })));
  return (env) => compiled.every((g) => g(env));
}

/* ------------------------------------------------------------------ */
/* Free variables                                                       */
/* ------------------------------------------------------------------ */

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
    case 'piecewise':
      for (const b of node.branches) {
        freeVars(b.condition, out);
        freeVars(b.value, out);
      }
      if (node.fallback) freeVars(node.fallback, out);
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

/* ------------------------------------------------------------------ */
/* Small AST helpers                                                    */
/* ------------------------------------------------------------------ */

const isIdent = (e: Expr, name: string): boolean => e.kind === 'ident' && e.name === name;

function synthBinary(op: '-', left: Expr, right: Expr): Expr {
  const span: Span = { start: left.span.start, end: right.span.end };
  return { kind: 'binary', op, left, right, span };
}

/** `y = rhs` / `lhs = y` with the other side free of y → that side, else null. */
function explicitBody(rel: Relation): Expr | null {
  if (rel.ops.length !== 1 || rel.ops[0] !== '=') return null;
  const [a, b] = rel.operands;
  if (isIdent(a, 'y') && !freeVars(b).has('y')) return b;
  if (isIdent(b, 'y') && !freeVars(a).has('y')) return a;
  return null;
}

/** `r = rhs` / `lhs = r` — polar when the body avoids x/y/t/r. */
function polarBody(rel: Relation): Expr | null {
  if (rel.ops.length !== 1 || rel.ops[0] !== '=') return null;
  const [a, b] = rel.operands;
  const body = isIdent(a, 'r') ? b : isIdent(b, 'r') ? a : null;
  if (body === null) return null;
  const vars = freeVars(body);
  return vars.has('x') || vars.has('y') || vars.has('t') || vars.has('r') ? null : body;
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

/**
 * A function definition `name(p, q, …) = body` (M9.5). The LHS must be the
 * call (definitions read left-to-right); the name must be non-reserved and
 * every parameter a distinct single-letter identifier. Reserved-name heads
 * (`sin(x) = 1`) return null and fall through to the implicit-equation
 * interpretation, so existing plots don't regress.
 */
export function functionDefinition(
  rel: Relation,
): { name: string; params: string[]; body: Expr } | null {
  if (rel.ops.length !== 1 || rel.ops[0] !== '=') return null;
  const lhs = rel.operands[0];
  if (lhs.kind !== 'call' || isReservedFunctionName(lhs.callee)) return null;
  const params: string[] = [];
  for (const arg of lhs.args) {
    if (arg.kind !== 'ident' || arg.name.length !== 1 || params.includes(arg.name)) return null;
    params.push(arg.name);
  }
  if (params.length === 0) return null;
  return { name: lhs.callee, params, body: rel.operands[1] };
}

/**
 * Parse a row as a function definition, with `fnNames` known so the LHS and
 * any user calls in the body resolve. Returns null when the row isn't a
 * definition or doesn't parse. Used to build the function scope before
 * per-row analysis (the two-pass naming flow).
 */
export function parseUserFunction(
  source: string,
  fnNames: Iterable<string>,
): { name: string; params: string[]; body: Expr } | null {
  if (source.trim() === '') return null;
  let ast: Expr;
  try {
    ast = expandCas(parse(source, { functionNames: EXTRA_FUNCTIONS, userFunctions: fnNames }));
  } catch {
    return null;
  }
  if (ast.kind !== 'relation') return null;
  return functionDefinition(ast);
}

/**
 * Build the document's function scope (M9.5) from every row's source. Two
 * passes: harvest names textually (so calls parse), then parse each
 * definition body with those names known. Names defined more than once, or
 * lying on a recursion cycle, are marked `invalid` (usable for parsing,
 * rejected at definition and call sites).
 */
export function buildFunctionScope(sources: Iterable<string>): FunctionScope {
  const rows = [...sources];

  // Pass 1: names + duplicate detection (textual head scan).
  const counts = new Map<string, number>();
  for (const src of rows) {
    const head = scanFunctionHead(src);
    if (head !== null && !isReservedFunctionName(head.name)) {
      counts.set(head.name, (counts.get(head.name) ?? 0) + 1);
    }
  }
  const names = new Set(counts.keys());

  // Pass 2: bodies for uniquely-defined names.
  const candidates = new Map<string, UserFunction>();
  for (const src of rows) {
    const parsed = parseUserFunction(src, names);
    if (parsed !== null && counts.get(parsed.name) === 1 && !candidates.has(parsed.name)) {
      candidates.set(parsed.name, { params: parsed.params, body: parsed.body });
    }
  }

  const invalid = new Map<string, string>();
  for (const [name, count] of counts) {
    if (count > 1) invalid.set(name, `"${name}" is defined more than once.`);
  }
  for (const name of detectFunctionCycles(candidates)) {
    invalid.set(name, `"${name}" is defined in terms of itself (recursion isn't supported).`);
  }

  const functions = new Map<string, UserFunction>();
  for (const [name, fn] of candidates) {
    if (!invalid.has(name)) functions.set(name, fn);
  }
  return { names, functions, invalid };
}

/**
 * Try to read a restriction condition as bounds on `varName`:
 * `a < t`, `t < b`, `a < t < b` (and >-directed forms). Returns the bound
 * expressions or null when the condition isn't a pure bound.
 */
function matchBounds(rel: Relation, varName: string): { lo?: Expr; hi?: Expr } | null {
  const increasing = rel.ops.every((op) => op === '<' || op === '<=');
  const decreasing = rel.ops.every((op) => op === '>' || op === '>=');
  if (!increasing && !decreasing) return null;
  const ops: Expr[] = rel.operands;
  const idx = ops.findIndex((o) => isIdent(o, varName));
  if (idx === -1) return null;
  // Every other operand must not mention the variable.
  for (let i = 0; i < ops.length; i++) {
    if (i !== idx && freeVars(ops[i]).has(varName)) return null;
  }
  const before = idx > 0 ? ops[idx - 1] : undefined;
  const after = idx < ops.length - 1 ? ops[idx + 1] : undefined;
  return increasing ? { lo: before, hi: after } : { lo: after, hi: before };
}

/* ------------------------------------------------------------------ */
/* Analyze                                                              */
/* ------------------------------------------------------------------ */

/**
 * User-function context for a document (M9.5). `names` are every defined
 * function name (needed so calls lex/parse); `functions` are the usable
 * (acyclic, unambiguous) definitions inlined at call sites; `invalid` maps
 * unusable names (recursive / defined-more-than-once) to the message shown
 * wherever they're defined or called.
 */
export interface FunctionScope {
  names: ReadonlySet<string>;
  functions: ReadonlyMap<string, UserFunction>;
  invalid: ReadonlyMap<string, string>;
}

const EMPTY_SCOPE: FunctionScope = { names: new Set(), functions: new Map(), invalid: new Map() };

export function analyze(
  source: string,
  angleMode: AngleMode,
  defined: ReadonlySet<string>,
  scope: FunctionScope = EMPTY_SCOPE,
): Analysis {
  if (source.trim() === '') return { kind: 'empty' };

  let parsed: Expr;
  try {
    parsed = parse(source, { functionNames: EXTRA_FUNCTIONS, userFunctions: scope.names });
  } catch (e) {
    if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
    throw e;
  }

  // Function definitions are recognized on the raw AST — before inlining would
  // rewrite the call-shaped LHS away. A name that's unusable (cyclic /
  // duplicated) reports its reason right on the definition row.
  if (parsed.kind === 'relation') {
    const fnDef = functionDefinition(parsed);
    if (fnDef !== null) {
      const reason = scope.invalid.get(fnDef.name);
      if (reason !== undefined) {
        return { kind: 'error', diagnostic: { kind: 'cas-unsupported', message: reason, span: parsed.span } };
      }
      return { kind: 'function-definition', ast: parsed, name: fnDef.name, params: fnDef.params, body: fnDef.body };
    }
  }

  try {
    // Inline user calls FIRST, then expand inline CAS — so derivative(f(x))
    // differentiates f's body, not an opaque call. After inlining, compile.ts
    // and the evaluator never see a user function. inlineFunctions raises
    // structured errors for cyclic/duplicated callees and arity mismatches.
    const inlined = inlineFunctions(parsed, scope.functions, scope.invalid);
    const ast = expandCas(inlined);
    return classify(ast, angleMode, defined);
  } catch (e) {
    if (e instanceof GcalcError) return { kind: 'error', diagnostic: e.info };
    throw e;
  }
}

function classify(ast: Expr, angleMode: AngleMode, defined: ReadonlySet<string>): Analysis {
  const opts = { angleMode };
  const coldCtx: EvalContext = makeContext({ angleMode });

  let core: Expr = ast;
  let restriction: Restriction | null = null;
  if (core.kind === 'restriction') {
    restriction = core;
    core = core.body;
  }
  const conditions: Relation[] = restriction ? restriction.conditions : [];

  /** Free vars of the whole line minus sampling vars must all be sliders. */
  const requireDeps = (sampling: string[]): readonly string[] | Analysis => {
    const vars = freeVars(ast);
    for (const s of sampling) vars.delete(s);
    const deps: string[] = [];
    for (const v of vars) {
      if (defined.has(v)) deps.push(v);
      else return unknownVariable(ast, v);
    }
    return deps.sort();
  };

  const withRestriction = (body: Expr): Expr =>
    restriction ? { ...restriction, body } : body;

  /**
   * Split restriction conditions on `varName` into range bounds and gates;
   * gates wrap a scalar closure so failed conditions become NaN gaps.
   */
  const boundsAndGates = (
    varName: string,
    defaultLo: number,
    defaultHi: number,
  ): { lo: BoundFn; hi: BoundFn; gate: (env: Env) => boolean } => {
    const los: CompiledFn[] = [];
    const his: CompiledFn[] = [];
    const gates: Array<(env: Env) => boolean> = [];
    for (const cond of conditions) {
      const m = matchBounds(cond, varName);
      if (m !== null && (m.lo !== undefined || m.hi !== undefined)) {
        if (m.lo !== undefined) los.push(compile(m.lo, opts));
        if (m.hi !== undefined) his.push(compile(m.hi, opts));
      } else {
        gates.push(compileCondition(cond, makeContext({ angleMode })));
      }
    }
    // Defaults apply only when no explicit bound was given; multiple
    // explicit bounds intersect (max of lowers, min of uppers).
    return {
      lo:
        los.length === 0
          ? () => defaultLo
          : (env) => los.reduce((acc, f) => Math.max(acc, f(env)), -Infinity),
      hi:
        his.length === 0
          ? () => defaultHi
          : (env) => his.reduce((acc, f) => Math.min(acc, f(env)), Infinity),
      gate: (env) => gates.every((g) => g(env)),
    };
  };

  /* ---- relations ---- */
  if (core.kind === 'relation') {
    const equation = core.ops.every((op) => op === '=');

    if (equation && core.ops.length === 1) {
      const body = explicitBody(core);
      if (body !== null) {
        const deps = requireDeps(['x', 'y']);
        if (!Array.isArray(deps)) return deps as Analysis;
        const restricted = withRestriction(body);
        const compiled = compile(restricted, opts);
        return {
          kind: 'plot',
          ast,
          deps,
          spec: {
            type: 'explicit',
            body: restricted,
            f: (x, env) => {
              env.x = x;
              return compiled(env);
            },
          },
        };
      }

      const rBody = polarBody(core);
      if (rBody !== null) {
        const deps = requireDeps(['theta', 'r']);
        if (!Array.isArray(deps)) return deps as Analysis;
        const compiled = compile(rBody, opts);
        const full = angleMode === 'degrees' ? 360 : 2 * Math.PI;
        const { lo, hi, gate } = boundsAndGates('theta', 0, full);
        return {
          kind: 'plot',
          ast,
          deps,
          spec: {
            type: 'polar',
            fr: (theta, env) => {
              env.theta = theta;
              return gate(env) ? compiled(env) : NaN;
            },
            th0: lo,
            th1: hi,
            toRad: angleMode === 'degrees' ? Math.PI / 180 : 1,
          },
        };
      }

      const def = definitionParts(core);
      if (def !== null && !restriction) {
        return { kind: 'definition', ast, name: def.name, value: evaluate(def.rhs, coldCtx) };
      }
    }

    // Implicit equation or inequality region over x/y.
    const deps = requireDeps(['x', 'y']);
    if (!Array.isArray(deps)) return deps as Analysis;

    const gates = conditions.map((c) => compileCondition(c, makeContext({ angleMode })));
    const gated = (env: Env): boolean => gates.every((g) => g(env));

    if (equation && core.ops.length === 1) {
      const compiled = compile(synthBinary('-', core.operands[0], core.operands[1]), opts);
      return {
        kind: 'plot',
        ast,
        deps,
        spec: {
          type: 'implicit',
          F: (x, y, env) => {
            env.x = x;
            env.y = y;
            return gated(env) ? compiled(env) : NaN;
          },
        },
      };
    }

    // Inequality (possibly chained, possibly mixing = steps): region.
    const insideCond = compileCondition(core, makeContext({ angleMode }));
    const boundaries: Array<{ F: (x: number, y: number, env: Env) => number; strict: boolean }> =
      [];
    for (let i = 0; i < core.ops.length; i++) {
      const op: RelOp = core.ops[i];
      const compiled = compile(synthBinary('-', core.operands[i], core.operands[i + 1]), opts);
      boundaries.push({
        F: (x, y, env) => {
          env.x = x;
          env.y = y;
          return gated(env) ? compiled(env) : NaN;
        },
        strict: op === '<' || op === '>',
      });
    }
    return {
      kind: 'plot',
      ast,
      deps,
      spec: {
        type: 'region',
        inside: (x, y, env) => {
          env.x = x;
          env.y = y;
          return gated(env) && insideCond(env);
        },
        boundaries,
      },
    };
  }

  /* ---- points: literal, parametric, or vector field ---- */
  if (core.kind === 'point') {
    const vars = freeVars(withRestriction(core));
    for (const d of defined) vars.delete(d);

    if (vars.has('t') && !vars.has('x') && !vars.has('y')) {
      const deps = requireDeps(['t']);
      if (!Array.isArray(deps)) return deps as Analysis;
      const cx = compile(core.x, opts);
      const cy = compile(core.y, opts);
      const { lo, hi, gate } = boundsAndGates('t', 0, 1);
      return {
        kind: 'plot',
        ast,
        deps,
        spec: {
          type: 'parametric',
          fx: (t, env) => {
            env.t = t;
            return gate(env) ? cx(env) : NaN;
          },
          fy: (t, env) => {
            env.t = t;
            return gate(env) ? cy(env) : NaN;
          },
          t0: lo,
          t1: hi,
        },
      };
    }

    if ((vars.has('x') || vars.has('y')) && !vars.has('t')) {
      const deps = requireDeps(['x', 'y']);
      if (!Array.isArray(deps)) return deps as Analysis;
      const gates = conditions.map((c) => compileCondition(c, makeContext({ angleMode })));
      const gated = (env: Env): boolean => gates.every((g) => g(env));
      const cP = compile(core.x, opts);
      const cQ = compile(core.y, opts);
      return {
        kind: 'plot',
        ast,
        deps,
        spec: {
          type: 'field',
          P: (x, y, env) => {
            env.x = x;
            env.y = y;
            return gated(env) ? cP(env) : NaN;
          },
          Q: (x, y, env) => {
            env.x = x;
            env.y = y;
            return gated(env) ? cQ(env) : NaN;
          },
        },
      };
    }

    if (vars.size === 0) {
      const deps = requireDeps([]);
      if (!Array.isArray(deps)) return deps as Analysis;
      return {
        kind: 'plot',
        ast,
        deps,
        spec: {
          type: 'points',
          pts: [{ fx: compile(core.x, opts), fy: compile(core.y, opts) }],
          gate: makeGate(conditions, angleMode),
        },
      };
    }

    return unknownVariable(ast, [...vars][0]);
  }

  /* ---- vector((x0,y0), (x1,y1)) ---- */
  if (core.kind === 'call' && core.callee === 'vector') {
    if (core.args.length !== 2 || core.args.some((a) => a.kind !== 'point')) {
      return {
        kind: 'unsupported',
        ast,
        reason: 'vector takes two points: vector((x0, y0), (x1, y1)).',
      };
    }
    const deps = requireDeps([]);
    if (!Array.isArray(deps)) return deps as Analysis;
    const [p, q] = core.args as Array<Extract<Expr, { kind: 'point' }>>;
    return {
      kind: 'plot',
      ast,
      deps,
      spec: {
        type: 'vector',
        from: { fx: compile(p.x, opts), fy: compile(p.y, opts) },
        to: { fx: compile(q.x, opts), fy: compile(q.y, opts) },
        gate: makeGate(conditions, angleMode),
      },
    };
  }

  /* ---- lists: data tables of points ---- */
  if (core.kind === 'list') {
    if (core.items.length > 0 && core.items.every((item) => item.kind === 'point')) {
      const deps = requireDeps([]);
      if (!Array.isArray(deps)) return deps as Analysis;
      const pts = (core.items as Array<Extract<Expr, { kind: 'point' }>>).map((p) => ({
        fx: compile(p.x, opts),
        fy: compile(p.y, opts),
      }));
      return {
        kind: 'plot',
        ast,
        deps,
        spec: { type: 'points', pts, gate: makeGate(conditions, angleMode) },
      };
    }
    return {
      kind: 'unsupported',
      ast,
      reason: 'Lists plot as data tables of points: [(1, 2), (3, 4)].',
    };
  }

  /* ---- scalar expressions ---- */
  const vars = freeVars(withRestriction(core));
  if (vars.size === 0 && !restriction) {
    return { kind: 'value', ast, value: evaluate(core, coldCtx) };
  }

  // Bare expression in x (and sliders) → y = expr, Desmos-style.
  const deps = requireDeps(['x']);
  if (!Array.isArray(deps)) return deps as Analysis;
  const restricted = withRestriction(core);
  const compiled = compile(restricted, opts);
  return {
    kind: 'plot',
    ast,
    deps,
    spec: {
      type: 'explicit',
      body: restricted,
      f: (x, env) => {
        env.x = x;
        return compiled(env);
      },
    },
  };
}

function unknownVariable(ast: Expr, name: string): Analysis {
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

/* ------------------------------------------------------------------ */
/* Pass-1 definition scan, edits, formatting (unchanged API)            */
/* ------------------------------------------------------------------ */

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
    const ast = parse(source, { functionNames: EXTRA_FUNCTIONS });
    if (ast.kind === 'relation') {
      // Polar `r = …` and explicit `y = …` are plots, never definitions.
      name = polarBody(ast) === null ? (definitionParts(ast)?.name ?? null) : null;
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
