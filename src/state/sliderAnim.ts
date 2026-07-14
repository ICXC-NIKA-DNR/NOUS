// Slider animation (Slider-Anim-M1): ▶ playback math for slider rows.
// Pure TypeScript — no DOM, no React — the rAF loop in App.tsx calls in here
// each frame and node:test covers the math in isolation.
//
// Semantics: one cycle = one full min → max → min sweep, a triangle wave in
// phase ∈ [0, 1): position rises to max at phase 0.5 and returns to min at 1,
// where the phase wraps and the next upward sweep begins (position is
// continuous through the wrap). Speed is a unitless multiplier on the base
// cycle rate; phase advances by Euler integration each frame so a variable
// multiplier (Slider-Anim-M2 speed curves) integrates correctly over real
// elapsed time — position over time is NOT a closed form once speed varies.

/** Full min→max→min cycle duration at 1× speed. */
export const BASE_CYCLE_MS = 8000;

/** Speed multiplier bounds. The range is log-centered on 1× (√(0.25·4) = 1),
 * which is also why the M2 curve editor's y-axis is log-scaled. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Per-frame delta cap: a tab suspend or GC stall pauses the animation for
 * the excess time instead of teleporting the phase in one giant Euler step. */
export const MAX_FRAME_DELTA_MS = 100;

export function clampSpeed(v: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
}

/** Triangle wave: phase ∈ [0, 1) → position fraction ∈ [0, 1]. */
export function trianglePosition(phase: number): number {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 2 * p : 2 - 2 * p;
}

export function sliderValueAt(phase: number, min: number, max: number): number {
  if (!(max > min)) return min;
  return min + (max - min) * trianglePosition(phase);
}

/** Inverse of sliderValueAt on the ascending branch: the phase to resume from
 * so pressing ▶ continues from the slider's current position. */
export function phaseFromValue(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const f = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return f / 2;
}

/** One Euler step: advance phase by elapsed real time × the instantaneous
 * multiplier at the current phase, wrapping at 1. `multiplierAt` is a
 * constant for flat speed or the M2 spline; its result is clamped to the
 * legal speed range either way. */
export function advancePhase(
  phase: number,
  deltaMs: number,
  multiplierAt: (phase: number) => number,
): number {
  const dt = Math.min(Math.max(deltaMs, 0), MAX_FRAME_DELTA_MS);
  const next = phase + (dt / BASE_CYCLE_MS) * clampSpeed(multiplierAt(phase));
  return next - Math.floor(next);
}

/** Format a slider value with just enough decimals for its step. */
export function formatSliderValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const s = value.toFixed(decimals);
  return s === '-0' ? '0' : s;
}
