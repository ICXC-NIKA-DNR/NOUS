import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleParametric } from '../parametric.ts';
import { pxToX, pxToY, xToPx, yToPx, type Viewport } from '../viewport.ts';

const vp: Viewport = { xMin: -10, xMax: 10, yMin: -5, yMax: 5, width: 800, height: 400 };

test('unit circle closes as one segment on the circle', () => {
  const segs = sampleParametric(Math.cos, Math.sin, 0, 2 * Math.PI, vp);
  assert.equal(segs.length, 1);
  const s = segs[0];
  // Every sampled point lies on the unit circle (within tolerance).
  for (let i = 0; i < s.length; i += 2) {
    const wx = pxToX(vp, s[i]);
    const wy = pxToY(vp, s[i + 1]);
    assert.ok(Math.abs(Math.hypot(wx, wy) - 1) < 0.01, `(${wx}, ${wy})`);
  }
  // Closed: first and last points coincide.
  assert.ok(Math.abs(s[0] - s[s.length - 2]) < 0.5);
  assert.ok(Math.abs(s[1] - s[s.length - 1]) < 0.5);
});

test('line through the viewport hits its endpoints', () => {
  const segs = sampleParametric((t) => t, (t) => t / 2, -10, 10, vp);
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok(Math.abs(s[0] - xToPx(vp, -10)) < 0.5);
  assert.ok(Math.abs(s[1] - yToPx(vp, -5)) < 0.5);
});

test('NaN interval splits the curve with accurate edges', () => {
  const segs = sampleParametric(
    (t) => t,
    (t) => (t > 1 && t < 2 ? NaN : 0),
    0,
    4,
    vp,
  );
  assert.equal(segs.length, 2);
  const leftEnd = segs[0][segs[0].length - 2];
  const rightStart = segs[1][0];
  assert.ok(Math.abs(leftEnd - xToPx(vp, 1)) < 0.5);
  assert.ok(Math.abs(rightStart - xToPx(vp, 2)) < 0.5);
});

test('asymptotic jump breaks the polyline: (t, 1/t)', () => {
  const segs = sampleParametric(
    (t) => t,
    (t) => 1 / t,
    -5,
    5,
    vp,
  );
  assert.equal(segs.length, 2);
  const poleX = xToPx(vp, 0);
  for (const s of segs) {
    const xs = [];
    for (let i = 0; i < s.length; i += 2) xs.push(s[i]);
    assert.ok(Math.max(...xs) < poleX + 1 || Math.min(...xs) > poleX - 1);
  }
});

test('high-frequency rose gets adaptive refinement', () => {
  // r = cos(7t) rose as parametric.
  const fx = (t: number): number => 3 * Math.cos(7 * t) * Math.cos(t);
  const fy = (t: number): number => 3 * Math.cos(7 * t) * Math.sin(t);
  const segs = sampleParametric(fx, fy, 0, 2 * Math.PI, vp);
  const points = segs.reduce((n, s) => n + s.length / 2, 0);
  assert.ok(points > 500, `expected dense sampling, got ${points}`);
});

test('everywhere-undefined yields nothing', () => {
  assert.deepEqual(sampleParametric(() => NaN, () => NaN, 0, 1, vp), []);
});
