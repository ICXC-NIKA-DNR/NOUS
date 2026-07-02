import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleCurve, type Segment } from '../sampler.ts';
import { pxToX, xToPx, yToPx, type Viewport } from '../viewport.ts';

const vp: Viewport = { xMin: -10, xMax: 10, yMin: -5, yMax: 5, width: 800, height: 400 };

const allPoints = (segs: Segment[]): Array<[number, number]> => {
  const pts: Array<[number, number]> = [];
  for (const s of segs) for (let i = 0; i < s.length; i += 2) pts.push([s[i], s[i + 1]]);
  return pts;
};

test('a line is one segment spanning the viewport', () => {
  const segs = sampleCurve((x) => x / 2, vp);
  assert.equal(segs.length, 1);
  const pts = allPoints(segs);
  assert.ok(Math.abs(pts[0][0] - 0) < 1e-9);
  assert.ok(Math.abs(pts[pts.length - 1][0] - 800) < 1e-9);
  // Every point sits on the line y = x/2 within tolerance.
  for (const [px, py] of pts) {
    const wx = pxToX(vp, px);
    assert.ok(Math.abs(py - yToPx(vp, wx / 2)) < 0.01);
  }
});

test('sin(x) is continuous and adaptively refined', () => {
  const segs = sampleCurve(Math.sin, vp);
  assert.equal(segs.length, 1);
  const pts = allPoints(segs);
  assert.ok(pts.length > 200, `expected refinement, got ${pts.length} points`);
  // Accurate at the extremum near x = pi/2.
  const target = xToPx(vp, Math.PI / 2);
  const nearest = pts.reduce((a, b) => (Math.abs(b[0] - target) < Math.abs(a[0] - target) ? b : a));
  assert.ok(Math.abs(nearest[1] - yToPx(vp, 1)) < 0.5);
});

test('1/x splits at the pole with no vertical connector', () => {
  const segs = sampleCurve((x) => 1 / x, vp);
  assert.equal(segs.length, 2);
  const poleX = xToPx(vp, 0);
  for (const s of segs) {
    const xs = [];
    for (let i = 0; i < s.length; i += 2) xs.push(s[i]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    // Each branch stays strictly on one side of the pole.
    assert.ok(maxX < poleX + 0.5 || minX > poleX - 0.5);
  }
  // Branch tips approach the pole and are clamped, not infinite.
  for (const [, py] of allPoints(segs)) {
    assert.ok(Number.isFinite(py));
    assert.ok(py >= -4 * vp.height && py <= 5 * vp.height);
  }
});

test('NaN gaps break the polyline at accurate boundaries', () => {
  // Domain restriction behavior: NaN inside (2, 4).
  const f = (x: number): number => (x > 2 && x < 4 ? NaN : x / 4);
  const segs = sampleCurve(f, vp);
  assert.equal(segs.length, 2);
  const leftEnd = segs[0][segs[0].length - 2];
  const rightStart = segs[1][0];
  assert.ok(Math.abs(leftEnd - xToPx(vp, 2)) < 0.5, `gap starts at ${leftEnd}`);
  assert.ok(Math.abs(rightStart - xToPx(vp, 4)) < 0.5, `gap ends at ${rightStart}`);
});

test('sqrt(x) starts exactly at the domain edge', () => {
  const segs = sampleCurve(Math.sqrt, vp);
  assert.equal(segs.length, 1);
  const first = segs[0][0];
  assert.ok(Math.abs(first - xToPx(vp, 0)) < 0.5, `starts at px ${first}`);
});

test('everywhere-NaN yields no segments', () => {
  assert.deepEqual(sampleCurve(() => NaN, vp), []);
});

test('tan(x) breaks at every asymptote in view', () => {
  const segs = sampleCurve(Math.tan, vp);
  // Asymptotes at ±pi/2, ±3pi/2, ±5pi/2 within [-10, 10] → 7 branches.
  assert.equal(segs.length, 7);
});
