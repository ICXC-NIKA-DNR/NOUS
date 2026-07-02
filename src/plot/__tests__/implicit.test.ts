import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contour, regionMask } from '../implicit.ts';
import { pxToX, pxToY, type Viewport } from '../viewport.ts';

// Square-unit viewport so circles are circles in px too.
const vp: Viewport = { xMin: -8, xMax: 8, yMin: -6, yMax: 6, width: 800, height: 600 };

test('circle contour: all segment points lie on the circle', () => {
  const F = (x: number, y: number): number => x * x + y * y - 25;
  const segs = contour(F, vp);
  assert.ok(segs.length > 50, `expected many cells crossed, got ${segs.length}`);
  for (const s of segs) {
    for (let i = 0; i < s.length; i += 2) {
      const wx = pxToX(vp, s[i]);
      const wy = pxToY(vp, s[i + 1]);
      const r = Math.hypot(wx, wy);
      assert.ok(Math.abs(r - 5) < 0.15, `point at r=${r}`);
    }
  }
});

test('two-branch hyperbola: no segment crosses the gap between branches', () => {
  const F = (x: number, y: number): number => x * y - 4; // xy = 4
  const segs = contour(F, vp);
  assert.ok(segs.length > 20);
  for (const s of segs) {
    // Each 2-point segment stays in one quadrant (short cell-local pieces).
    const q1 = Math.sign(pxToX(vp, s[0]));
    const q2 = Math.sign(pxToX(vp, s[2]));
    assert.ok(q1 === q2 || q1 === 0 || q2 === 0);
  }
});

test('NaN cells produce no contour (restriction gating)', () => {
  const F = (x: number, y: number): number => (x < 0 ? NaN : x * x + y * y - 25);
  const segs = contour(F, vp);
  for (const s of segs) {
    for (let i = 0; i < s.length; i += 2) {
      assert.ok(pxToX(vp, s[i]) > -0.5, 'no contour in the restricted half');
    }
  }
});

test('no zero crossing, no output', () => {
  assert.deepEqual(contour((x, y) => x * x + y * y + 1, vp), []);
});

test('regionMask covers the right area fraction for a disc', () => {
  const inside = (x: number, y: number): boolean => x * x + y * y < 16;
  const mask = regionMask(inside, vp);
  let on = 0;
  for (const c of mask.cells) if (c === 255) on++;
  const fraction = on / mask.cells.length;
  // Disc area / viewport area = pi*16 / (16*12) ≈ 0.2618
  assert.ok(Math.abs(fraction - 0.2618) < 0.02, `fraction=${fraction.toFixed(4)}`);
});

test('regionMask treats NaN conditions as outside', () => {
  const inside = (x: number, _y: number): boolean => {
    const v = x < 0 ? NaN : 1;
    return v > 0; // NaN comparison → false
  };
  const mask = regionMask(inside, vp);
  let on = 0;
  for (const c of mask.cells) if (c === 255) on++;
  assert.ok(Math.abs(on / mask.cells.length - 0.5) < 0.02);
});
