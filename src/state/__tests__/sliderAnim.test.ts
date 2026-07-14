// Slider-Anim-M1: playback math in isolation. The rAF loop in App.tsx is a
// thin caller of these — triangle-wave position, phase resume, and the
// per-frame Euler integration step (variable multipliers arrive in M2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCurveNode,
  advancePhase,
  BASE_CYCLE_MS,
  clampSpeed,
  defaultCurveNodes,
  formatSliderValue,
  MAX_CURVE_NODES,
  MAX_FRAME_DELTA_MS,
  metaMultiplier,
  MIN_NODE_GAP,
  moveCurveNode,
  phaseFromValue,
  prepareCurve,
  removeCurveNode,
  sliderValueAt,
  SPEED_MAX,
  SPEED_MIN,
  trianglePosition,
  type CurveNode,
} from '../sliderAnim.ts';

test('trianglePosition: min→max→min over one cycle', () => {
  assert.equal(trianglePosition(0), 0);
  assert.equal(trianglePosition(0.25), 0.5);
  assert.equal(trianglePosition(0.5), 1);
  assert.equal(trianglePosition(0.75), 0.5);
  assert.ok(Math.abs(trianglePosition(0.999) - 0.002) < 1e-12);
  // Out-of-range phases wrap.
  assert.equal(trianglePosition(1.25), 0.5);
  assert.equal(trianglePosition(-0.75), 0.5);
});

test('sliderValueAt maps the triangle into [min, max]', () => {
  assert.equal(sliderValueAt(0, -10, 10), -10);
  assert.equal(sliderValueAt(0.5, -10, 10), 10);
  assert.equal(sliderValueAt(0.25, 0, 4), 2);
  // Degenerate range holds at min instead of dividing by zero.
  assert.equal(sliderValueAt(0.3, 5, 5), 5);
});

test('phaseFromValue is the ascending-branch inverse of sliderValueAt', () => {
  for (const v of [-10, -3.5, 0, 7.25, 10]) {
    const phase = phaseFromValue(v, -10, 10);
    assert.ok(phase >= 0 && phase <= 0.5);
    assert.ok(Math.abs(sliderValueAt(phase, -10, 10) - v) < 1e-12);
  }
  // Out-of-range values clamp; degenerate range resumes at 0.
  assert.equal(phaseFromValue(99, -10, 10), 0.5);
  assert.equal(phaseFromValue(-99, -10, 10), 0);
  assert.equal(phaseFromValue(3, 5, 5), 0);
});

test('Euler integration: constant multiplier accumulates exactly', () => {
  // 60 frames of 16⅔ ms = 1000 ms at 1× → 1/8 of the 8000 ms cycle.
  let phase = 0;
  for (let i = 0; i < 60; i++) phase = advancePhase(phase, 1000 / 60, () => 1);
  assert.ok(Math.abs(phase - 1000 / BASE_CYCLE_MS) < 1e-9);
  // 2× covers twice the phase in the same time.
  phase = 0;
  for (let i = 0; i < 60; i++) phase = advancePhase(phase, 1000 / 60, () => 2);
  assert.ok(Math.abs(phase - 2000 / BASE_CYCLE_MS) < 1e-9);
});

test('Euler integration: synthetic variable multiplier matches analytic sum', () => {
  // multiplier = 1 in the first half-cycle, 3 in the second. Integrate in
  // small steps and check against the piecewise-analytic expectation.
  const mult = (p: number): number => (p < 0.5 ? 1 : 3);
  let phase = 0;
  let elapsed = 0;
  const step = 5; // ms
  while (phase < 0.5) {
    phase = advancePhase(phase, step, mult);
    elapsed += step;
  }
  // First half at 1×: 0.5 cycles ≈ 4000 ms (within one step of the boundary).
  assert.ok(Math.abs(elapsed - BASE_CYCLE_MS / 2) <= step + 1e-9);
  // Second half at 3× should take one third of the time.
  let elapsed2 = 0;
  while (phase >= 0.5) {
    phase = advancePhase(phase, step, mult);
    elapsed2 += step;
  }
  assert.ok(Math.abs(elapsed2 - BASE_CYCLE_MS / 6) <= step + 1e-9);
});

test('advancePhase wraps at 1.0 back onto the ascending sweep', () => {
  const phase = advancePhase(0.999, 100, () => 4); // + 0.05 → wraps
  assert.ok(phase >= 0 && phase < 0.1);
  // Position is continuous through the wrap: both sides sit near min.
  assert.ok(sliderValueAt(0.999, 0, 1) < 0.01);
  assert.ok(sliderValueAt(phase, 0, 1) < 0.1);
});

test('advancePhase clamps frame-delta spikes and negative deltas', () => {
  // A 5-second stall advances only MAX_FRAME_DELTA_MS worth of phase.
  const spiked = advancePhase(0, 5000, () => 1);
  assert.equal(spiked, MAX_FRAME_DELTA_MS / BASE_CYCLE_MS);
  assert.equal(advancePhase(0.3, -50, () => 1), 0.3);
});

test('advancePhase clamps the multiplier to the legal speed range', () => {
  assert.equal(advancePhase(0, 80, () => 100), (80 / BASE_CYCLE_MS) * 4);
  assert.equal(advancePhase(0, 80, () => 0), (80 / BASE_CYCLE_MS) * 0.25);
  assert.equal(clampSpeed(-3), 0.25);
  assert.equal(clampSpeed(1.5), 1.5);
});

test('formatSliderValue: decimals follow the step', () => {
  assert.equal(formatSliderValue(1.23456, 0.1), '1.2');
  assert.equal(formatSliderValue(1.23456, 0.01), '1.23');
  assert.equal(formatSliderValue(3.7, 1), '4');
  assert.equal(formatSliderValue(-0.4, 1), '0');
});

/* ---- Slider-Anim-M2: speed-curve spline ---- */

test('spline: a single node is a constant multiplier', () => {
  const at = prepareCurve([{ phase: 0, multiplier: 2 }], 'hard');
  for (const p of [0, 0.3, 0.7, 0.999]) assert.equal(at(p), 2);
  const smooth = prepareCurve([{ phase: 0, multiplier: 2 }], 'smooth');
  assert.equal(smooth(0.5), 2);
});

test('spline: interpolates through its control points exactly', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.4, multiplier: 4 },
    { phase: 0.8, multiplier: 0.5 },
  ];
  for (const seam of ['hard', 'smooth'] as const) {
    const at = prepareCurve(nodes, seam);
    for (const n of nodes) assert.ok(Math.abs(at(n.phase) - n.multiplier) < 1e-12, `${seam} @${n.phase}`);
  }
});

test('spline: known interpolated value (hand-computed PCHIP in log₂ space)', () => {
  // Nodes (0, 1×) → (0.5, 4×), hard seam. Knots in log₂: (0,0), (0.5,2) plus
  // the flat hold (1,2). Endpoint tangent m0 = secant = 4; the interior knot
  // gets tangent 0 (flat segment adjacent). Hermite at t=0.5 on [0,0.5]:
  // y = 0.5·0 + 0.125·0.5·4 + 0.5·2 − 0.125·0.5·0 = 1.25 → 2^1.25.
  const at = prepareCurve(
    [
      { phase: 0, multiplier: 1 },
      { phase: 0.5, multiplier: 4 },
    ],
    'hard',
  );
  assert.ok(Math.abs(at(0.25) - 2 ** 1.25) < 1e-12);
  // Past the last node the hard seam holds the value flat…
  assert.ok(Math.abs(at(0.75) - 4) < 1e-12);
  assert.ok(Math.abs(at(0.9999) - 4) < 1e-12);
  // …and phase 1 ≡ phase 0 (the wrap happens inside the evaluator).
  assert.equal(at(1), at(0));
});

test('spline: monotone — never overshoots the band its nodes span', () => {
  const at = prepareCurve(
    [
      { phase: 0, multiplier: 0.5 },
      { phase: 0.3, multiplier: 3.5 },
      { phase: 0.6, multiplier: 0.3 },
    ],
    'hard',
  );
  for (let i = 0; i <= 1000; i++) {
    const v = at(i / 1000);
    assert.ok(v >= 0.3 - 1e-9 && v <= 3.5 + 1e-9, `overshoot at ${i / 1000}: ${v}`);
  }
});

test('spline seam: smooth is continuous across the wrap, hard jumps', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.5, multiplier: 4 },
  ];
  const smooth = prepareCurve(nodes, 'smooth');
  // Approaching phase 1 the smooth curve returns to node 0's multiplier.
  assert.ok(Math.abs(smooth(0.9999) - 1) < 0.01);
  assert.ok(Math.abs(smooth(1) - smooth(0)) < 1e-12);
  const hard = prepareCurve(nodes, 'hard');
  assert.ok(Math.abs(hard(0.9999) - 4) < 0.01); // held at the last node…
  assert.equal(hard(0), 1); // …then pops to the anchor at the restart
});

test('spline: defensive about out-of-range multipliers from hostile input', () => {
  const at = prepareCurve(
    [
      { phase: 0, multiplier: 100 },
      { phase: 0.5, multiplier: 0.001 },
    ],
    'hard',
  );
  for (let i = 0; i <= 100; i++) {
    const v = at(i / 100);
    assert.ok(v >= SPEED_MIN && v <= SPEED_MAX);
  }
});

/* ---- Slider-Anim-M2: node CRUD ---- */

test('addCurveNode: caps at MAX_CURVE_NODES, keeps sort order, preserves shape', () => {
  let nodes = defaultCurveNodes(2);
  assert.deepEqual(nodes, [{ phase: 0, multiplier: 2 }]);
  const before = prepareCurve(nodes, 'hard');
  for (let i = 0; i < 10; i++) nodes = addCurveNode(nodes, 'hard');
  assert.equal(nodes.length, MAX_CURVE_NODES);
  for (let i = 1; i < nodes.length; i++) assert.ok(nodes[i].phase > nodes[i - 1].phase);
  assert.equal(nodes[0].phase, 0);
  // New nodes land on the existing curve, so the shape is unchanged.
  const after = prepareCurve(nodes, 'hard');
  for (let i = 0; i <= 20; i++) {
    assert.ok(Math.abs(after(i / 20) - before(i / 20)) < 1e-9);
  }
});

test('removeCurveNode: floors at 1 node and never removes the anchor', () => {
  let nodes = defaultCurveNodes(1);
  nodes = addCurveNode(nodes, 'hard');
  nodes = addCurveNode(nodes, 'hard');
  assert.equal(nodes.length, 3);
  nodes = removeCurveNode(nodes);
  nodes = removeCurveNode(nodes);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].phase, 0); // the anchor survives
  assert.equal(removeCurveNode(nodes), nodes); // floor: no-op
});

test('moveCurveNode: anchor x is immutable, y clamps to the speed range', () => {
  const nodes = defaultCurveNodes(1);
  const moved = moveCurveNode(nodes, 0, 0.7, 9);
  assert.equal(moved[0].phase, 0);
  assert.equal(moved[0].multiplier, SPEED_MAX);
  assert.equal(moveCurveNode(nodes, 0, 0.3, 0.01)[0].multiplier, SPEED_MIN);
});

test('moveCurveNode: x clamps between neighbors — nodes never cross', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.3, multiplier: 2 },
    { phase: 0.6, multiplier: 1 },
  ];
  // Drag the middle node far right: stops MIN_NODE_GAP short of its neighbor.
  const right = moveCurveNode(nodes, 1, 0.95, 2);
  assert.ok(Math.abs(right[1].phase - (0.6 - MIN_NODE_GAP)) < 1e-12);
  // Far left: stops MIN_NODE_GAP past the anchor.
  const left = moveCurveNode(nodes, 1, -5, 2);
  assert.ok(Math.abs(left[1].phase - MIN_NODE_GAP) < 1e-12);
  // The last node's right boundary is the cycle end.
  const end = moveCurveNode(nodes, 2, 2, 2);
  assert.ok(Math.abs(end[2].phase - (1 - MIN_NODE_GAP)) < 1e-12);
  for (const out of [right, left, end]) {
    for (let i = 1; i < out.length; i++) assert.ok(out[i].phase > out[i - 1].phase);
  }
});

/* ---- Slider-Anim-M2: curve-driven integration ---- */

test('metaMultiplier: speedMode picks the source; both configs coexist', () => {
  const meta = {
    speed: 2,
    speedMode: 'flat' as const,
    curveNodes: [{ phase: 0, multiplier: 0.5 }],
  };
  assert.equal(metaMultiplier(meta)(0.3), 2);
  assert.equal(metaMultiplier({ ...meta, speedMode: 'curve' })(0.3), 0.5);
  // No curve stored yet: curve mode falls back to flat rather than crashing.
  assert.equal(metaMultiplier({ speed: 3, speedMode: 'curve' })(0), 3);
});

test('integration through a curve: fast half / slow half take asymmetric time', () => {
  // 4× for the first half-cycle, 1× for the second (hard seam, step nodes
  // far apart so the spline is flat in each half around the samples).
  const at = prepareCurve(
    [
      { phase: 0, multiplier: 4 },
      { phase: 0.45, multiplier: 4 },
      { phase: 0.55, multiplier: 1 },
    ],
    'hard',
  );
  let phase = 0;
  let msToHalf = 0;
  while (phase < 0.5) {
    phase = advancePhase(phase, 2, at);
    msToHalf += 2;
  }
  let msToWrap = 0;
  while (phase >= 0.5) {
    phase = advancePhase(phase, 2, at);
    msToWrap += 2;
  }
  // First half at ~4×: ~1000ms. Second at ~1×: ~4000ms. The spline blends
  // around the step, so allow a loose band — the asymmetry is the point.
  assert.ok(msToHalf > 800 && msToHalf < 1400, `fast half took ${msToHalf}ms`);
  assert.ok(msToWrap > 3200 && msToWrap < 4400, `slow half took ${msToWrap}ms`);
});
