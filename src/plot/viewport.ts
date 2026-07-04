// Viewport: the visible world-coordinate window and its mapping to CSS pixels.
// Pure math — no DOM. y grows upward in world space, downward in screen space.

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
}

export function xToPx(vp: Viewport, x: number): number {
  return ((x - vp.xMin) / (vp.xMax - vp.xMin)) * vp.width;
}

export function yToPx(vp: Viewport, y: number): number {
  return vp.height - ((y - vp.yMin) / (vp.yMax - vp.yMin)) * vp.height;
}

export function pxToX(vp: Viewport, px: number): number {
  return vp.xMin + (px / vp.width) * (vp.xMax - vp.xMin);
}

export function pxToY(vp: Viewport, py: number): number {
  return vp.yMin + ((vp.height - py) / vp.height) * (vp.yMax - vp.yMin);
}

/** Default view: x spans [-10, 10], y range chosen so units are square. */
export function defaultViewport(width: number, height: number): Viewport {
  const xSpan = 20;
  const ySpan = (xSpan * height) / width;
  return {
    xMin: -xSpan / 2,
    xMax: xSpan / 2,
    yMin: -ySpan / 2,
    yMax: ySpan / 2,
    width,
    height,
  };
}

/** Shift the window by a screen-pixel delta (drag right = world moves left). */
export function pan(vp: Viewport, dxPx: number, dyPx: number): Viewport {
  const dx = (-dxPx / vp.width) * (vp.xMax - vp.xMin);
  const dy = (dyPx / vp.height) * (vp.yMax - vp.yMin);
  return { ...vp, xMin: vp.xMin + dx, xMax: vp.xMax + dx, yMin: vp.yMin + dy, yMax: vp.yMax + dy };
}

// Zoom limits: keep spans within a range where doubles still have plenty of
// precision and tick math stays sane.
const MIN_SPAN = 1e-9;
const MAX_SPAN = 1e12;

/**
 * Zoom by `factor` (>1 zooms out) keeping the world point under the cursor
 * (px, py) fixed on screen.
 */
export function zoomAt(vp: Viewport, px: number, py: number, factor: number): Viewport {
  const xSpan = (vp.xMax - vp.xMin) * factor;
  const ySpan = (vp.yMax - vp.yMin) * factor;
  if (
    Math.min(xSpan, ySpan) < MIN_SPAN ||
    Math.max(xSpan, ySpan) > MAX_SPAN
  ) {
    return vp;
  }
  const cx = pxToX(vp, px);
  const cy = pxToY(vp, py);
  const fx = px / vp.width;
  const fy = (vp.height - py) / vp.height;
  return {
    ...vp,
    xMin: cx - fx * xSpan,
    xMax: cx + (1 - fx) * xSpan,
    yMin: cy - fy * ySpan,
    yMax: cy + (1 - fy) * ySpan,
  };
}

/**
 * Re-target the viewport to a new canvas size, preserving the world-per-pixel
 * scale on BOTH axes about the view centre. Resizing the window therefore
 * reveals more (or less) area at the same zoom instead of stretching the
 * graph — square units stay square, the way Desmos behaves. (Preserving the
 * x *range* while only y tracked pixels — the previous behaviour — skewed the
 * aspect ratio on every horizontal resize.)
 */
export function resize(vp: Viewport, width: number, height: number): Viewport {
  if (vp.width === width && vp.height === height) return vp;
  const xPerPx = (vp.xMax - vp.xMin) / vp.width;
  const yPerPx = (vp.yMax - vp.yMin) / vp.height;
  const xMid = (vp.xMin + vp.xMax) / 2;
  const yMid = (vp.yMin + vp.yMax) / 2;
  const xSpan = xPerPx * width;
  const ySpan = yPerPx * height;
  return {
    xMin: xMid - xSpan / 2,
    xMax: xMid + xSpan / 2,
    yMin: yMid - ySpan / 2,
    yMax: yMid + ySpan / 2,
    width,
    height,
  };
}
