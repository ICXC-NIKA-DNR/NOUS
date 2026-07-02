// Axis tick stepping and label formatting. Steps follow the 1-2-5 progression
// so gridlines land on friendly numbers at every zoom level.

/**
 * Pick a tick step of the form {1,2,5}·10^k so that consecutive ticks are at
 * least `minPx` pixels apart on an axis `axisPx` pixels long covering `range`
 * world units.
 */
export function tickStep(range: number, axisPx: number, minPx = 60): number {
  const rough = (range * minPx) / axisPx;
  const mag = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 5]) {
    if (mag * m >= rough) return mag * m;
  }
  return mag * 10;
}

/** All multiples of `step` inside [min, max], inclusive. */
export function tickValues(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first; v <= max + step * 1e-9; v += step) {
    // Snap to a clean multiple to cancel accumulated float error.
    const snapped = Math.round(v / step) * step;
    out.push(snapped === 0 ? 0 : snapped); // normalize -0
  }
  return out;
}

/** Format a tick label with just enough digits for the given step. */
export function formatTick(value: number, step: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) {
    return value.toExponential(2).replace(/\.?0+e/, 'e');
  }
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return value.toFixed(decimals);
}
