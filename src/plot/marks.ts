// Discrete marks: points, vectors (arrows), and vector fields. Like
// render.ts these take a CanvasRenderingContext2D — all math stays in the
// callers/engines.

import { xToPx, yToPx, pxToX, pxToY, type Viewport } from './viewport.ts';

export function drawPointMark(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, 2 * Math.PI);
  ctx.fill();
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  widthPx = 2,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const head = Math.min(10, 4 + len * 0.12);
  const ux = dx / len;
  const uy = dy / len;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = widthPx;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head - uy * head * 0.45, y1 - uy * head + ux * head * 0.45);
  ctx.lineTo(x1 - ux * head + uy * head * 0.45, y1 - uy * head - ux * head * 0.45);
  ctx.closePath();
  ctx.fill();
}

/**
 * Vector field (P(x,y), Q(x,y)): one arrow per grid cell (~spacingPx), all
 * arrows scaled by the same factor so relative magnitudes stay comparable;
 * the longest arrow in view fits the cell.
 */
export function drawVectorField(
  ctx: CanvasRenderingContext2D,
  P: (x: number, y: number) => number,
  Q: (x: number, y: number) => number,
  vp: Viewport,
  color: string,
  spacingPx = 48,
): void {
  const cols = Math.max(2, Math.floor(vp.width / spacingPx));
  const rows = Math.max(2, Math.floor(vp.height / spacingPx));
  const stepX = vp.width / cols;
  const stepY = vp.height / rows;

  interface FieldSample {
    px: number;
    py: number;
    vx: number;
    vy: number;
    mag: number;
  }
  const samples: FieldSample[] = [];
  let maxMag = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = (i + 0.5) * stepX;
      const py = (j + 0.5) * stepY;
      const wx = pxToX(vp, px);
      const wy = pxToY(vp, py);
      const vx = P(wx, wy);
      const vy = Q(wx, wy);
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
      // World-direction → screen-direction: y flips.
      const mag = Math.hypot(vx, vy);
      samples.push({ px, py, vx, vy: -vy, mag });
      if (mag > maxMag) maxMag = mag;
    }
  }
  if (maxMag === 0) return;

  const maxLen = Math.min(stepX, stepY) * 0.85;
  for (const s of samples) {
    if (s.mag === 0) continue;
    const len = (s.mag / maxMag) * maxLen;
    if (len < 2) continue;
    const ux = s.vx / Math.hypot(s.vx, s.vy);
    const uy = s.vy / Math.hypot(s.vx, s.vy);
    drawArrow(
      ctx,
      s.px - (ux * len) / 2,
      s.py - (uy * len) / 2,
      s.px + (ux * len) / 2,
      s.py + (uy * len) / 2,
      color,
      1.5,
    );
  }
}

/** Convenience: world-space point → mark. */
export function drawWorldPoint(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  wx: number,
  wy: number,
  color: string,
): void {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
  drawPointMark(ctx, xToPx(vp, wx), yToPx(vp, wy), color);
}
