import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultViewport,
  pan,
  pxToX,
  pxToY,
  resize,
  xToPx,
  yToPx,
  zoomAt,
  type Viewport,
} from '../viewport.ts';

const vp: Viewport = { xMin: -10, xMax: 10, yMin: -5, yMax: 5, width: 800, height: 400 };

test('world<->screen transforms round-trip', () => {
  for (const x of [-10, -3.7, 0, 5.2, 10]) {
    assert.ok(Math.abs(pxToX(vp, xToPx(vp, x)) - x) < 1e-12);
  }
  for (const y of [-5, -0.1, 0, 2.5, 5]) {
    assert.ok(Math.abs(pxToY(vp, yToPx(vp, y)) - y) < 1e-12);
  }
  // Screen y is flipped: yMax is at the top (py = 0).
  assert.equal(yToPx(vp, 5), 0);
  assert.equal(yToPx(vp, -5), 400);
});

test('defaultViewport has square units', () => {
  const d = defaultViewport(800, 400);
  const xPerPx = (d.xMax - d.xMin) / d.width;
  const yPerPx = (d.yMax - d.yMin) / d.height;
  assert.ok(Math.abs(xPerPx - yPerPx) < 1e-12);
  assert.equal(d.xMin, -10);
  assert.equal(d.xMax, 10);
});

test('pan moves the window opposite the drag', () => {
  const dragged = pan(vp, 80, 0); // drag right by 80px = 2 world units
  assert.ok(Math.abs(dragged.xMin - -12) < 1e-12);
  assert.ok(Math.abs(dragged.xMax - 8) < 1e-12);
  const draggedDown = pan(vp, 0, 40); // drag down 40px = world moves up 1
  assert.ok(Math.abs(draggedDown.yMin - -4) < 1e-12);
  assert.ok(Math.abs(draggedDown.yMax - 6) < 1e-12);
});

test('zoomAt keeps the cursor point fixed', () => {
  const px = 600;
  const py = 100;
  const wx = pxToX(vp, px);
  const wy = pxToY(vp, py);
  const zoomed = zoomAt(vp, px, py, 0.5);
  assert.ok(Math.abs(xToPx(zoomed, wx) - px) < 1e-9);
  assert.ok(Math.abs(yToPx(zoomed, wy) - py) < 1e-9);
  assert.ok(Math.abs(zoomed.xMax - zoomed.xMin - 10) < 1e-12);
});

test('zoomAt refuses to zoom past precision limits', () => {
  const tiny: Viewport = { ...vp, xMin: -1e-10, xMax: 1e-10, yMin: -1e-10, yMax: 1e-10 };
  assert.equal(zoomAt(tiny, 400, 200, 0.5), tiny);
  const huge: Viewport = { ...vp, xMin: -1e12, xMax: 1e12, yMin: -1e12, yMax: 1e12 };
  assert.equal(zoomAt(huge, 400, 200, 2), huge);
});

test('resize preserves world-per-pixel on both axes and the centre', () => {
  // vp: x∈[-10,10] over 800px (0.025/px), y∈[-5,5] over 400px (0.025/px).
  const xPerPx = (vp.xMax - vp.xMin) / vp.width;
  const yPerPx = (vp.yMax - vp.yMin) / vp.height;
  const r = resize(vp, 1600, 800);
  // Same scale on both axes → no aspect skew; more area revealed, not stretched.
  assert.ok(Math.abs((r.xMax - r.xMin) / r.width - xPerPx) < 1e-12);
  assert.ok(Math.abs((r.yMax - r.yMin) / r.height - yPerPx) < 1e-12);
  // Centre held.
  assert.ok(Math.abs((r.xMin + r.xMax) / 2 - 0) < 1e-12);
  assert.ok(Math.abs((r.yMin + r.yMax) / 2 - 0) < 1e-12);
  // Doubling width at fixed scale doubles the visible x-span.
  assert.ok(Math.abs(r.xMax - r.xMin - 40) < 1e-12);
});

test('resize keeps square units square', () => {
  const square = defaultViewport(800, 400); // square by construction
  const r = resize(square, 500, 900);
  const xPerPx = (r.xMax - r.xMin) / r.width;
  const yPerPx = (r.yMax - r.yMin) / r.height;
  assert.ok(Math.abs(xPerPx - yPerPx) < 1e-12);
});
