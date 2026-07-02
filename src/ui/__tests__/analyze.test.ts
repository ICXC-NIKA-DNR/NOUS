import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, applyEdit, formatValue, freeVars } from '../analyze.ts';
import { parse } from '../../core/parser.ts';
import { toTex } from '../tex.ts';

test('y = sin(x) is a plot', () => {
  const a = analyze('y = sin(x)', 'radians');
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.ok(Math.abs(a.f(Math.PI / 2) - 1) < 1e-12);
});

test('x^2 = y (flipped sides) is a plot', () => {
  const a = analyze('x^2 = y', 'radians');
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.equal(a.f(3), 9);
});

test('bare expression in x plots as y = expr', () => {
  const a = analyze('x^3 - x', 'radians');
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.equal(a.f(2), 6);
});

test('restriction gives NaN gaps and stays a plot', () => {
  const a = analyze('y = x {x > 0}', 'radians');
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.equal(a.f(5), 5);
  assert.ok(Number.isNaN(a.f(-5)));
});

test('angle mode threads through to evaluation', () => {
  const a = analyze('y = sin(x)', 'degrees');
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.ok(Math.abs(a.f(90) - 1) < 1e-12);
});

test('constant expression is a value', () => {
  const a = analyze('2 + 2 * 2', 'radians');
  assert.equal(a.kind, 'value');
  if (a.kind !== 'value') return;
  assert.equal(a.value, 6);
});

test('undefined variable carries the create-slider suggestion', () => {
  const a = analyze('y = a x^2', 'radians');
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'undefined-variable');
  assert.equal(a.diagnostic.suggestion?.action, 'create-slider');
  assert.equal(a.diagnostic.suggestion?.name, 'a');
});

test('parse errors surface the core diagnostic', () => {
  const a = analyze('y = sin(x', 'radians');
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'unmatched-paren');
  assert.ok(a.diagnostic.suggestion?.edit);
});

test('inequalities are flagged as M4', () => {
  const a = analyze('y > x', 'radians');
  assert.equal(a.kind, 'unsupported');
});

test('empty and whitespace input', () => {
  assert.equal(analyze('', 'radians').kind, 'empty');
  assert.equal(analyze('   ', 'radians').kind, 'empty');
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
  assert.equal(formatValue(0.5), '0.5');
  assert.equal(formatValue(NaN), 'undefined');
  assert.equal(formatValue(Infinity), '∞');
});

/* toTex — the display layer's spec */

const tex = (src: string): string => toTex(parse(src));

test('toTex renders functions upright and variables italic', () => {
  assert.equal(tex('sin(x)'), '\\sin\\left(x\\right)');
  assert.equal(tex('y = x^2'), 'y = x^{2}');
});

test('toTex uses \\frac for division', () => {
  assert.equal(tex('1/x'), '\\frac{1}{x}');
  assert.equal(tex('(x+1)/(x-1)'), '\\frac{x + 1}{x - 1}');
});

test('toTex juxtaposes implicit products but keeps explicit dots', () => {
  assert.equal(tex('2x'), '2 x');
  assert.equal(tex('2*3'), '2 \\cdot 3');
});

test('toTex parenthesizes by precedence', () => {
  assert.equal(tex('(x+1)^2'), '\\left(x + 1\\right)^{2}');
  assert.equal(tex('-x^2'), '-x^{2}');
  assert.equal(tex('(-x)^2'), '\\left(-x\\right)^{2}');
});

test('toTex renders greek, sqrt, abs, and restrictions', () => {
  assert.equal(tex('pi'), '\\pi');
  assert.equal(tex('sqrt(x)'), '\\sqrt{x}');
  assert.equal(tex('|x|'), '\\left|x\\right|');
  assert.equal(tex('x^2 {0 < x < 5}'), 'x^{2} \\;\\left\\{0 < x < 5\\right\\}');
});
