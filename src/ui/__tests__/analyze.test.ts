import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, applyEdit, formatValue, freeVars, type Analysis, type PlotSpec } from '../analyze.ts';
import type { AngleMode } from '../../core/evaluator.ts';
import { parse } from '../../core/parser.ts';
import { toTex } from '../tex.ts';

const NONE: ReadonlySet<string> = new Set();
const an = (src: string, mode: AngleMode = 'radians', defined: ReadonlySet<string> = NONE) =>
  analyze(src, mode, defined);

function spec<T extends PlotSpec['type']>(a: Analysis, type: T): Extract<PlotSpec, { type: T }> {
  assert.equal(a.kind, 'plot', `expected a plot, got ${a.kind}`);
  const s = (a as Extract<Analysis, { kind: 'plot' }>).spec;
  assert.equal(s.type, type, `expected ${type}, got ${s.type}`);
  return s as Extract<PlotSpec, { type: T }>;
}

/* ---- explicit ---- */

test('y = sin(x) is an explicit plot', () => {
  const s = spec(an('y = sin(x)'), 'explicit');
  assert.ok(Math.abs(s.f(Math.PI / 2, {}) - 1) < 1e-12);
});

test('bare expression and flipped sides are explicit', () => {
  assert.equal(spec(an('x^3 - x'), 'explicit').f(2, {}), 6);
  assert.equal(spec(an('x^2 = y'), 'explicit').f(3, {}), 9);
});

test('piecewise plots as explicit', () => {
  const s = spec(an('{x < 0: -x, x}'), 'explicit');
  assert.equal(s.f(-3, {}), 3);
  assert.equal(s.f(4, {}), 4);
});

test('restriction gives NaN gaps on explicit plots', () => {
  const s = spec(an('y = x {x > 0}'), 'explicit');
  assert.equal(s.f(5, {}), 5);
  assert.ok(Number.isNaN(s.f(-5, {})));
});

test('angle mode threads through', () => {
  const s = spec(an('y = sin(x)', 'degrees'), 'explicit');
  assert.ok(Math.abs(s.f(90, {}) - 1) < 1e-12);
});

/* ---- parametric ---- */

test('(cos t, sin t) is parametric with default t in [0,1]', () => {
  const s = spec(an('(cos(t), sin(t))'), 'parametric');
  assert.equal(s.t0({}), 0);
  assert.equal(s.t1({}), 1);
  assert.ok(Math.abs(s.fx(0, {}) - 1) < 1e-12);
  assert.ok(Math.abs(s.fy(Math.PI / 2, {}) - 1) < 1e-12);
});

test('parametric t-range comes from the restriction, slider bounds allowed', () => {
  const s = spec(an('(cos(t), sin(t)) {0 < t < 2pi}'), 'parametric');
  assert.equal(s.t0({}), 0);
  assert.ok(Math.abs(s.t1({}) - 2 * Math.PI) < 1e-12);
  const s2 = spec(an('(t, t^2) {0 < t < k}', 'radians', new Set(['k'])), 'parametric');
  assert.equal(s2.t1({ k: 3 }), 3);
});

test('non-bound restriction conditions gate parametric points', () => {
  const s = spec(an('(t, t) {t^2 < 4}'), 'parametric');
  assert.ok(Number.isNaN(s.fx(3, {})));
  assert.equal(s.fx(1, {}), 1);
});

/* ---- polar ---- */

test('r = f(theta) is polar with default full turn', () => {
  const s = spec(an('r = 2cos(3theta)'), 'polar');
  assert.ok(Math.abs(s.th1({}) - 2 * Math.PI) < 1e-12);
  assert.ok(Math.abs(s.fr(0, {}) - 2) < 1e-12);
});

test('polar range respects restriction and degrees mode', () => {
  const s = spec(an('r = theta {0 < theta < pi}'), 'polar');
  assert.ok(Math.abs(s.th1({}) - Math.PI) < 1e-12);
  const sDeg = spec(an('r = 1', 'degrees'), 'polar');
  assert.equal(sDeg.th1({}), 360);
});

test('r = 2 is a polar circle, not a slider definition', () => {
  spec(an('r = 2'), 'polar');
});

/* ---- implicit + regions ---- */

test('x^2 + y^2 = 25 is implicit with F = lhs - rhs', () => {
  const s = spec(an('x^2 + y^2 = 25'), 'implicit');
  assert.equal(s.F(3, 4, {}), 0);
  assert.equal(s.F(0, 0, {}), -25);
});

test('x = 1 is an implicit vertical line', () => {
  const s = spec(an('x = 1'), 'implicit');
  assert.equal(s.F(1, 99, {}), 0);
});

test('y > x^2 is a region with a dashed (strict) boundary', () => {
  const s = spec(an('y > x^2'), 'region');
  assert.ok(s.inside(0, 1, {}));
  assert.ok(!s.inside(0, -1, {}));
  assert.equal(s.boundaries.length, 1);
  assert.ok(s.boundaries[0].strict);
});

test('chained inequality region: 1 < x^2 + y^2 <= 4 (annulus)', () => {
  const s = spec(an('1 < x^2 + y^2 <= 4'), 'region');
  assert.ok(s.inside(1.2, 0, {}));
  assert.ok(!s.inside(0.5, 0, {}));
  assert.ok(!s.inside(3, 0, {}));
  assert.equal(s.boundaries.length, 2);
  assert.ok(s.boundaries[0].strict);
  assert.ok(!s.boundaries[1].strict);
});

test('restriction gates regions', () => {
  const s = spec(an('y < x {x > 0}'), 'region');
  assert.ok(s.inside(2, 1, {}));
  assert.ok(!s.inside(-2, -3, {}));
});

/* ---- points, vectors, fields ---- */

test('a literal point and a list of points plot as points', () => {
  const p = spec(an('(1, 2)'), 'points');
  assert.equal(p.pts.length, 1);
  assert.equal(p.pts[0].fy({}), 2);
  const l = spec(an('[(1, 2), (3, 4), (5, 6)]'), 'points');
  assert.equal(l.pts.length, 3);
  assert.equal(l.pts[2].fx({}), 5);
});

test('point restriction gates visibility', () => {
  const p = spec(an('(k, k) {k > 0}', 'radians', new Set(['k'])), 'points');
  assert.ok(p.gate({ k: 1 }));
  assert.ok(!p.gate({ k: -1 }));
});

test('vector((0,0), (3,4)) is a vector', () => {
  const v = spec(an('vector((0, 0), (3, 4))'), 'vector');
  assert.equal(v.to.fx({}), 3);
  assert.equal(v.to.fy({}), 4);
});

test('a point in x and y is a vector field', () => {
  const f = spec(an('(-y, x)'), 'field');
  assert.equal(f.P(2, 3, {}), -3);
  assert.equal(f.Q(2, 3, {}), 2);
});

/* ---- definitions, values, errors ---- */

test('a = 1 is a definition; deps track sliders', () => {
  const a = an('a = 1');
  assert.equal(a.kind, 'definition');
  const p = an('y = a x + b', 'radians', new Set(['a', 'b']));
  assert.equal(p.kind, 'plot');
  if (p.kind !== 'plot') return;
  assert.deepEqual(p.deps, ['a', 'b']);
});

test('constant expression is a value', () => {
  const a = an('2 + 2 * 2');
  assert.equal(a.kind, 'value');
  if (a.kind !== 'value') return;
  assert.equal(a.value, 6);
});

test('undefined variable carries the create-slider suggestion', () => {
  const a = an('y = a x^2');
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'undefined-variable');
  assert.equal(a.diagnostic.suggestion?.action, 'create-slider');
  assert.equal(a.diagnostic.suggestion?.name, 'a');
});

test('parse errors surface the core diagnostic', () => {
  const a = an('y = sin(x');
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'unmatched-paren');
  assert.ok(a.diagnostic.suggestion?.edit);
});

test('empty and whitespace input', () => {
  assert.equal(an('').kind, 'empty');
  assert.equal(an('   ').kind, 'empty');
});

test('freeVars ignores constants and function names', () => {
  const vars = freeVars(parse('pi sin(x) + e^k'));
  assert.deepEqual([...vars].sort(), ['k', 'x']);
});

test('applyEdit performs insert and replace edits', () => {
  assert.equal(applyEdit('sin(x', { type: 'insert', at: 5, text: ')' }), 'sin(x)');
  assert.equal(
    applyEdit('sni(x)', { type: 'replace', span: { start: 0, end: 3 }, text: 'sin' }),
    'sin(x)',
  );
});

test('formatValue trims noise', () => {
  assert.equal(formatValue(6), '6');
  assert.equal(formatValue(Math.PI), '3.14159');
  assert.equal(formatValue(NaN), 'undefined');
});

/* ---- toTex ---- */

const tex = (src: string): string => toTex(parse(src));

test('toTex renders functions upright, fractions, precedence', () => {
  assert.equal(tex('sin(x)'), '\\sin\\left(x\\right)');
  assert.equal(tex('1/x'), '\\frac{1}{x}');
  assert.equal(tex('(x+1)^2'), '\\left(x + 1\\right)^{2}');
  assert.equal(tex('2x'), '2 x');
  assert.equal(tex('2*3'), '2 \\cdot 3');
});

test('toTex renders piecewise as cases', () => {
  assert.equal(
    tex('{x < 0: -x, x}'),
    '\\begin{cases}-x & x < 0 \\\\ x & \\text{otherwise}\\end{cases}',
  );
});

test('toTex renders greek, sqrt, abs, and restrictions', () => {
  assert.equal(tex('pi'), '\\pi');
  assert.equal(tex('sqrt(x)'), '\\sqrt{x}');
  assert.equal(tex('|x|'), '\\left|x\\right|');
  assert.equal(tex('x^2 {0 < x < 5}'), 'x^{2} \\;\\left\\{0 < x < 5\\right\\}');
});
