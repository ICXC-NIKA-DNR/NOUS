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
  cycleDurationMs,
  defaultCurveNodes,
  formatSliderValue,
  MAX_CURVE_NODES,
  MAX_FRAME_DELTA_MS,
  metaMultiplier,
  MIN_NODE_GAP,
  moveCurveNode,
  normalizedCurveNodes,
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
  // Past the last node the hard seam holds the value flat, INCLUDING the
  // domain end — the evaluator clamps rather than wraps (M4: phase 1 is the
  // end anchor; playback wraps in advancePhase before it ever gets here).
  assert.ok(Math.abs(at(0.75) - 4) < 1e-12);
  assert.ok(Math.abs(at(1) - 4) < 1e-12);
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

/* ---- Slider-Anim-M3: linear interpolation & node normalization ---- */

test('linear mode: straight segments in log₂ space through the same nodes', () => {
  const at = prepareCurve(
    [
      { phase: 0, multiplier: 1 },
      { phase: 1, multiplier: 4 },
    ],
    'hard',
    'flat',
  );
  // log₂ lerp: 0 → 2 over [0,1]; midpoint = 2¹ = 2×, quarter = 2^0.5.
  assert.ok(Math.abs(at(0.5) - 2) < 1e-12);
  assert.ok(Math.abs(at(0.25) - 2 ** 0.5) < 1e-12);
  // Two equal anchors = the old constant flat speed, in either mode.
  const flat = prepareCurve(defaultCurveNodes(2), 'smooth', 'flat');
  const curved = prepareCurve(defaultCurveNodes(2), 'smooth', 'curve');
  for (const p of [0, 0.3, 0.7]) {
    assert.equal(flat(p), 2);
    assert.equal(curved(p), 2);
  }
});

test('seam lock: smooth forces the end anchor onto node 0, hard keeps the pop', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 1, multiplier: 4 }, // anchors deliberately unequal
  ];
  // Hard: the stored end anchor stands — speed approaches 4× then pops to 1×.
  const hard = prepareCurve(nodes, 'hard', 'curve');
  assert.ok(Math.abs(hard(0.9999) - 4) < 0.01);
  assert.equal(hard(0), 1);
  // Smooth: the lock overrides the stored value — no pop.
  const smooth = prepareCurve(nodes, 'smooth', 'curve');
  assert.ok(Math.abs(smooth(0.9999) - 1) < 0.01);
  assert.equal(smooth(1), smooth(0));
});

test('normalizedCurveNodes: seeds, upgrades legacy lists, passes anchored lists through', () => {
  // Absent → two 1× anchors.
  assert.deepEqual(normalizedCurveNodes({}), defaultCurveNodes());
  // Legacy hard list → end anchor at the held last value (old playback kept).
  const hard = normalizedCurveNodes({
    curveNodes: [
      { phase: 0, multiplier: 1 },
      { phase: 0.5, multiplier: 4 },
    ],
    loopSeam: 'hard',
  });
  assert.deepEqual(hard[hard.length - 1], { phase: 1, multiplier: 4 });
  // Legacy smooth list → end anchor at node 0's value.
  const smooth = normalizedCurveNodes({
    curveNodes: [
      { phase: 0, multiplier: 1 },
      { phase: 0.5, multiplier: 4 },
    ],
    loopSeam: 'smooth',
  });
  assert.deepEqual(smooth[smooth.length - 1], { phase: 1, multiplier: 1 });
  // A full legacy list has no room: its last free node becomes the anchor.
  const full = normalizedCurveNodes({
    curveNodes: [0, 0.2, 0.4, 0.6, 0.8].map((phase) => ({ phase, multiplier: 2 })),
    loopSeam: 'hard',
  });
  assert.equal(full.length, MAX_CURVE_NODES);
  assert.deepEqual(full[full.length - 1], { phase: 1, multiplier: 2 });
  // Already anchored → unchanged, same reference.
  assert.equal(normalizedCurveNodes({ curveNodes: hard }), hard);
});

/* ---- Slider-Anim-M3: node CRUD (2 anchors + up to 3 middles) ---- */

test('addCurveNode: middles only, caps at 5 total, preserves shape and order', () => {
  let nodes = defaultCurveNodes(2);
  assert.equal(nodes.length, 2);
  const before = prepareCurve(nodes, 'hard', 'curve');
  for (let i = 0; i < 10; i++) nodes = addCurveNode(nodes, 'hard', 'curve');
  assert.equal(nodes.length, MAX_CURVE_NODES);
  for (let i = 1; i < nodes.length; i++) assert.ok(nodes[i].phase > nodes[i - 1].phase);
  assert.equal(nodes[0].phase, 0);
  assert.equal(nodes[nodes.length - 1].phase, 1); // end anchor stays the end
  // New nodes land on the existing curve, so the shape is unchanged.
  const after = prepareCurve(nodes, 'hard', 'curve');
  for (let i = 0; i <= 20; i++) {
    assert.ok(Math.abs(after(i / 20) - before(i / 20)) < 1e-9);
  }
});

test('removeCurveNode: floors at the 2 anchors, removes middles only', () => {
  let nodes = defaultCurveNodes(1);
  nodes = addCurveNode(nodes, 'hard', 'flat');
  nodes = addCurveNode(nodes, 'hard', 'flat');
  assert.equal(nodes.length, 4);
  nodes = removeCurveNode(nodes);
  nodes = removeCurveNode(nodes);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].phase, 0); // both anchors survive
  assert.equal(nodes[1].phase, 1);
  assert.equal(removeCurveNode(nodes), nodes); // floor: no-op
});

test('moveCurveNode: anchor x pinned; smooth seam locks both anchors’ y together', () => {
  const nodes = defaultCurveNodes(1);
  // Hard: anchors move vertically, independently.
  const start = moveCurveNode(nodes, 0, 0.7, 9, 'hard');
  assert.equal(start[0].phase, 0);
  assert.equal(start[0].multiplier, SPEED_MAX); // y clamps
  assert.equal(start[1].multiplier, 1); // end anchor untouched
  const end = moveCurveNode(nodes, 1, 0.3, 0.01, 'hard');
  assert.equal(end[1].phase, 1);
  assert.equal(end[1].multiplier, SPEED_MIN);
  assert.equal(end[0].multiplier, 1);
  // Smooth: dragging either anchor moves both.
  const synced = moveCurveNode(nodes, 1, 0.3, 3, 'smooth');
  assert.equal(synced[0].multiplier, 3);
  assert.equal(synced[1].multiplier, 3);
  assert.equal(synced[0].phase, 0);
  assert.equal(synced[1].phase, 1);
});

test('moveCurveNode: middle x clamps between neighbors — nodes never cross', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.3, multiplier: 2 },
    { phase: 0.6, multiplier: 1 },
    { phase: 1, multiplier: 1 },
  ];
  // Drag a middle node far right: stops MIN_NODE_GAP short of its neighbor.
  const right = moveCurveNode(nodes, 1, 0.95, 2, 'hard');
  assert.ok(Math.abs(right[1].phase - (0.6 - MIN_NODE_GAP)) < 1e-12);
  // Far left: stops MIN_NODE_GAP past the start anchor.
  const left = moveCurveNode(nodes, 1, -5, 2, 'hard');
  assert.ok(Math.abs(left[1].phase - MIN_NODE_GAP) < 1e-12);
  // The last middle's right boundary is the end anchor.
  const end = moveCurveNode(nodes, 2, 2, 2, 'hard');
  assert.ok(Math.abs(end[2].phase - (1 - MIN_NODE_GAP)) < 1e-12);
  for (const out of [right, left, end]) {
    for (let i = 1; i < out.length; i++) assert.ok(out[i].phase > out[i - 1].phase);
  }
});

/* ---- curve-driven integration ---- */

test('metaMultiplier: node graph drives playback; speedMode picks interpolation', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.5, multiplier: 4 },
    { phase: 1, multiplier: 1 },
  ];
  // Linear vs PCHIP differ mid-segment on the same nodes (with 2 nodes PCHIP
  // degenerates to the same straight line, so use 3). roundTrip span: this
  // test reads the curve by cycle-phase directly.
  const rt = { loopSeam: 'hard', graphSpan: 'roundTrip' } as const;
  const linear = metaMultiplier({ speedMode: 'flat', curveNodes: nodes, ...rt });
  const curved = metaMultiplier({ speedMode: 'curve', curveNodes: nodes, ...rt });
  assert.ok(Math.abs(linear(0.25) - 2) < 1e-12); // log-lerp midpoint of 1×→4×
  assert.ok(Math.abs(curved(0.25) - 2 ** 1.25) < 1e-12); // PCHIP hand value
  assert.equal(linear(0.5), curved(0.5)); // both pass through the nodes
  // Fresh sliders (no nodes) run at 1×.
  assert.equal(metaMultiplier({})(0.3), 1);
  assert.equal(metaMultiplier({ speedMode: 'curve' })(0.3), 1);
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

/* ---- Slider-Anim-M4: graphSpan — positional x-axis ---- */

test('oneWay: the return leg retraces the same curve in reverse', () => {
  // Asymmetric curve so cycle-phase and value-position lookups differ.
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.3, multiplier: 4 },
    { phase: 1, multiplier: 1 },
  ];
  const oneWay = metaMultiplier({ speedMode: 'flat', curveNodes: nodes, graphSpan: 'oneWay' });
  const roundTrip = metaMultiplier({
    speedMode: 'flat',
    curveNodes: nodes,
    loopSeam: 'hard',
    graphSpan: 'roundTrip',
  });
  // Same position on the way up (phase 0.2 → tri 0.4) and the way back
  // (phase 0.8 → tri 0.4): oneWay reads the same speed, roundTrip doesn't.
  assert.ok(Math.abs(oneWay(0.2) - oneWay(0.8)) < 1e-12);
  assert.ok(Math.abs(roundTrip(0.2) - roundTrip(0.8)) > 0.1);
  // At the max turnaround (phase 0.5 → position 1) oneWay reads the END
  // anchor — the speed at max — not the cycle midpoint.
  assert.ok(Math.abs(oneWay(0.5) - 1) < 1e-12);
  // Hand value: position 0.15 is the log-lerp midpoint of the 1×→4× segment.
  assert.ok(Math.abs(oneWay(0.075) - 2) < 1e-12);
});

test('oneWay honors the seam lock: smooth pins speed-at-max to speed-at-min', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 1, multiplier: 4 }, // anchors deliberately unequal
  ];
  // Hard: independent anchors — 4× at the max turnaround (position 1).
  const hard = metaMultiplier({
    speedMode: 'flat',
    curveNodes: nodes,
    loopSeam: 'hard',
    graphSpan: 'oneWay',
  });
  assert.ok(Math.abs(hard(0.5) - 4) < 1e-12);
  // Smooth (the default): the lock overrides the stored end anchor, so the
  // speeds at min and max match.
  const smooth = metaMultiplier({ speedMode: 'flat', curveNodes: nodes, graphSpan: 'oneWay' });
  assert.ok(Math.abs(smooth(0.5) - 1) < 1e-12);
  // Either way the wrap is speed-continuous under bounce (retrace reflects).
  for (const at of [hard, smooth]) {
    assert.ok(Math.abs(at(0.999) - at(0.001)) < 0.01);
  }
});

test('graphSpan defaults to oneWay; roundTrip preserves M3 cycle semantics', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.3, multiplier: 4 },
    { phase: 1, multiplier: 1 },
  ];
  const defaulted = metaMultiplier({ speedMode: 'flat', curveNodes: nodes });
  const oneWay = metaMultiplier({ speedMode: 'flat', curveNodes: nodes, graphSpan: 'oneWay' });
  for (const p of [0.1, 0.4, 0.8]) assert.equal(defaulted(p), oneWay(p));
  // roundTrip reads the curve by cycle-phase directly (the M3 behavior).
  const rt = metaMultiplier({
    speedMode: 'flat',
    curveNodes: nodes,
    loopSeam: 'hard',
    graphSpan: 'roundTrip',
  });
  const direct = prepareCurve(nodes, 'hard', 'flat');
  for (const p of [0.1, 0.4, 0.8]) assert.equal(rt(p), direct(p));
});

/* ---- Slider-Anim-M5: loop vs bounce ---- */

test('loop position mapping: sawtooth min→max, jump at the wrap', () => {
  assert.equal(sliderValueAt(0, -10, 10, 'loop'), -10);
  assert.equal(sliderValueAt(0.5, -10, 10, 'loop'), 0); // halfway UP, not at max
  assert.ok(Math.abs(sliderValueAt(0.999, -10, 10, 'loop') - 9.98) < 1e-9);
  // The wrap jumps back to min — no return leg.
  assert.equal(sliderValueAt(1, -10, 10, 'loop'), -10);
  // Bounce at the same phases is unchanged by the new parameter's existence.
  assert.equal(sliderValueAt(0.5, -10, 10), 10);
  assert.equal(sliderValueAt(0.5, -10, 10, 'bounce'), 10);
});

test('phaseFromValue inverts the loop mapping across the whole range', () => {
  for (const v of [-10, -3.5, 0, 7.25]) {
    const phase = phaseFromValue(v, -10, 10, 'loop');
    assert.ok(phase >= 0 && phase < 1);
    assert.ok(Math.abs(sliderValueAt(phase, -10, 10, 'loop') - v) < 1e-12);
  }
  // The max is the jump point: its phase is 1, which the sawtooth has
  // already wrapped to min — resuming at max means the jump comes first.
  assert.equal(phaseFromValue(10, -10, 10, 'loop'), 1);
  assert.equal(sliderValueAt(1, -10, 10, 'loop'), -10);
  assert.equal(phaseFromValue(3, 5, 5, 'loop'), 0); // degenerate range
});

test('loop cycle = one leg (4s at 1×), so mode switching is not a hidden 2×', () => {
  assert.equal(cycleDurationMs('bounce'), BASE_CYCLE_MS);
  assert.equal(cycleDurationMs('loop'), BASE_CYCLE_MS / 2);
  // 1000 ms at 1×: bounce covers 1/8 cycle, loop covers 1/4 — but both have
  // moved the SAME distance along the range (bounce leg = half its cycle).
  let bounce = 0;
  let loop = 0;
  for (let i = 0; i < 60; i++) {
    bounce = advancePhase(bounce, 1000 / 60, () => 1, cycleDurationMs('bounce'));
    loop = advancePhase(loop, 1000 / 60, () => 1, cycleDurationMs('loop'));
  }
  const bounceDist = sliderValueAt(bounce, 0, 1) - 0;
  const loopDist = sliderValueAt(loop, 0, 1, 'loop') - 0;
  assert.ok(Math.abs(bounceDist - loopDist) < 1e-9);
});

test('metaMultiplier under loop: positional lookup with the seam at the jump', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 1, multiplier: 4 }, // anchors deliberately unequal
  ];
  // Hard seam: speed ramps to 4× at max, then pops back to 1× at the jump.
  const hard = metaMultiplier({
    speedMode: 'flat',
    curveNodes: nodes,
    loopSeam: 'hard',
    animMode: 'loop',
  });
  assert.ok(Math.abs(hard(0.999) - 4) < 0.01);
  assert.equal(hard(0), 1);
  // Smooth seam (default): the anchor lock keeps the jump speed-continuous.
  const smooth = metaMultiplier({ speedMode: 'flat', curveNodes: nodes, animMode: 'loop' });
  assert.ok(Math.abs(smooth(0.999) - smooth(0.001)) < 0.01);
});

test('bounce playback is byte-identical with animMode absent or explicit', () => {
  const nodes: CurveNode[] = [
    { phase: 0, multiplier: 1 },
    { phase: 0.3, multiplier: 4 },
    { phase: 1, multiplier: 0.5 },
  ];
  for (const speedMode of ['flat', 'curve'] as const) {
    const implicit = metaMultiplier({ speedMode, curveNodes: nodes, loopSeam: 'hard' });
    const explicit = metaMultiplier({ speedMode, curveNodes: nodes, loopSeam: 'hard', animMode: 'bounce' });
    for (let i = 0; i <= 40; i++) assert.equal(implicit(i / 40), explicit(i / 40));
  }
  for (const p of [0, 0.3, 0.7]) {
    assert.equal(sliderValueAt(p, -5, 5), sliderValueAt(p, -5, 5, 'bounce'));
    assert.equal(phaseFromValue(p * 10 - 5, -5, 5), phaseFromValue(p * 10 - 5, -5, 5, 'bounce'));
  }
});
