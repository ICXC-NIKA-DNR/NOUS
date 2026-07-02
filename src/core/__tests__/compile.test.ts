// compile() vs the recursive evaluator: the evaluator is the oracle
// (CLAUDE.md). Random expressions are generated from a seeded grammar so
// failures reproduce, then both engines evaluate at random points in both
// angle modes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Env } from '../compile.ts';
import { evaluate, makeContext, type AngleMode } from '../evaluator.ts';
import { GcalcError } from '../errors.ts';
import { parse } from '../parser.ts';

/* Seeded RNG (mulberry32) so every run tests the same expressions. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VARS = ['x', 'a', 'b'];
const UNARY_FUNCS = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'ln', 'exp', 'atan', 'floor', 'sinh'];
const CONSTS = ['pi', 'e', '2', '3', '0.5', '10', '0'];

function genExpr(r: () => number, depth: number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  if (depth <= 0) {
    return r() < 0.5 ? pick(VARS) : pick(CONSTS);
  }
  const roll = r();
  if (roll < 0.35) {
    const op = pick(['+', '-', '*', '/', '^']);
    // Keep ^ exponents small and simple to avoid astronomic/NaN-only trees.
    const right = op === '^' ? pick(['2', '3', '0.5', 'x']) : genExpr(r, depth - 1);
    return `(${genExpr(r, depth - 1)}) ${op} (${right})`;
  }
  if (roll < 0.6) {
    return `${pick(UNARY_FUNCS)}(${genExpr(r, depth - 1)})`;
  }
  if (roll < 0.7) {
    return `${pick(['mod', 'max', 'min'])}(${genExpr(r, depth - 1)}, ${genExpr(r, depth - 1)})`;
  }
  if (roll < 0.78) {
    return `-(${genExpr(r, depth - 1)})`;
  }
  if (roll < 0.86) {
    return `(${pick(['3', '4', '5'])})!`;
  }
  return genExpr(r, depth - 1);
}

/** Same value: both NaN, or equal within relative tolerance. */
function agree(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true; // covers ±Infinity
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function checkExpr(source: string, angleMode: AngleMode, points: Array<Record<string, number>>): void {
  const ast = parse(source);
  const compiled = compile(ast, { angleMode });
  for (const point of points) {
    const env: Env = { ...point };
    const vars = new Map(Object.entries(point));
    const ctx = makeContext({ angleMode, variables: vars });
    let oracle: number;
    try {
      oracle = evaluate(ast, ctx);
    } catch (e) {
      if (e instanceof GcalcError) continue; // e.g. relations — compile throws too, tested separately
      throw e;
    }
    const got = compiled(env);
    assert.ok(
      agree(oracle, got),
      `${source} @ ${JSON.stringify(point)} [${angleMode}]: oracle=${oracle} compiled=${got}`,
    );
  }
}

test('property: compiled closures agree with the evaluator', () => {
  const r = rng(0xc0ffee);
  const samplePoints = (): Array<Record<string, number>> => {
    const pts: Array<Record<string, number>> = [];
    for (let i = 0; i < 12; i++) {
      pts.push({ x: (r() - 0.5) * 20, a: (r() - 0.5) * 6, b: (r() - 0.5) * 6 });
    }
    // Edge points: zero, negatives, large.
    pts.push({ x: 0, a: 0, b: 0 }, { x: -1, a: 1, b: -1 }, { x: 100, a: -50, b: 0.001 });
    return pts;
  };
  for (let i = 0; i < 400; i++) {
    const source = genExpr(r, 4);
    const mode: AngleMode = i % 2 === 0 ? 'radians' : 'degrees';
    checkExpr(source, mode, samplePoints());
  }
});

test('property: restrictions gate to NaN identically', () => {
  const r = rng(0xbead5);
  for (let i = 0; i < 100; i++) {
    const body = genExpr(r, 3);
    const bound = (r() * 8 - 4).toFixed(2);
    const source = `${body} {x > ${bound}}`;
    checkExpr(source, 'radians', [{ x: -10, a: 1, b: 2 }, { x: 0, a: 1, b: 2 }, { x: 10, a: 1, b: 2 }]);
  }
});

test('chained and multi-condition restrictions agree', () => {
  checkExpr('x^2 {0 < x < 5}', 'radians', [{ x: -1 }, { x: 0 }, { x: 2.5 }, { x: 5 }, { x: 7 }]);
  checkExpr('x {x > -2, x < 2}', 'radians', [{ x: -3 }, { x: 0 }, { x: 3 }]);
  checkExpr('1 {x = 2}', 'radians', [{ x: 2 }, { x: 2.0000000001 }, { x: 3 }]);
});

test('angle mode is baked in correctly', () => {
  const deg = compile(parse('sin(x)'), { angleMode: 'degrees' });
  const rad = compile(parse('sin(x)'), { angleMode: 'radians' });
  assert.ok(Math.abs(deg({ x: 90 }) - 1) < 1e-12);
  assert.ok(Math.abs(rad({ x: Math.PI / 2 }) - 1) < 1e-12);
  const adeg = compile(parse('asin(1)'), { angleMode: 'degrees' });
  assert.ok(Math.abs(adeg({}) - 90) < 1e-12);
});

test('undefined variable at call time is a NaN gap, not a throw', () => {
  const f = compile(parse('a x + b'), { angleMode: 'radians' });
  assert.ok(Number.isNaN(f({ x: 1 })));
  assert.equal(f({ x: 1, a: 2, b: 3 }), 5);
});

test('sliders shadow constants, like the evaluator', () => {
  const f = compile(parse('e + 1'), { angleMode: 'radians' });
  assert.ok(Math.abs(f({}) - (Math.E + 1)) < 1e-12);
  assert.equal(f({ e: 1 }), 2);
});

test('compile rejects what the evaluator rejects, at compile time', () => {
  assert.throws(() => compile(parse('sin(1, 2)'), { angleMode: 'radians' }), GcalcError);
  assert.throws(() => compile(parse('(1, 2)'), { angleMode: 'radians' }), GcalcError);
  assert.throws(() => compile(parse('x < 1'), { angleMode: 'radians' }), GcalcError);
});
