// Canvas 2D drawing: grid, axes, labels, curves. Takes sampled segments —
// all math lives in viewport.ts/ticks.ts/sampler.ts.

import type { Segment } from './sampler.ts';
import { tickStep, tickValues, formatTick } from './ticks.ts';
import { xToPx, yToPx, type Viewport } from './viewport.ts';

export interface Theme {
  grid: string;
  gridMinor: string;
  axis: string;
  label: string;
  fontPx: number;
  fontFamily: string;
}

export interface CurveStyle {
  color: string;
  widthPx: number;
}

export function drawGrid(ctx: CanvasRenderingContext2D, vp: Viewport, theme: Theme): void {
  const xStep = tickStep(vp.xMax - vp.xMin, vp.width);
  const yStep = tickStep(vp.yMax - vp.yMin, vp.height);

  // Minor gridlines at 1/5 of the major step (or 1/4 when the major mantissa
  // is 2, so minors stay clean).
  const minorDiv = (step: number): number => {
    const mant = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    return Math.round(mant) === 2 ? 4 : 5;
  };

  ctx.lineWidth = 1;

  ctx.strokeStyle = theme.gridMinor;
  ctx.beginPath();
  for (const v of tickValues(vp.xMin, vp.xMax, xStep / minorDiv(xStep))) {
    const px = Math.round(xToPx(vp, v)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, vp.height);
  }
  for (const v of tickValues(vp.yMin, vp.yMax, yStep / minorDiv(yStep))) {
    const py = Math.round(yToPx(vp, v)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(vp.width, py);
  }
  ctx.stroke();

  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  for (const v of tickValues(vp.xMin, vp.xMax, xStep)) {
    const px = Math.round(xToPx(vp, v)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, vp.height);
  }
  for (const v of tickValues(vp.yMin, vp.yMax, yStep)) {
    const py = Math.round(yToPx(vp, v)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(vp.width, py);
  }
  ctx.stroke();

  // Axes.
  const axisX = xToPx(vp, 0);
  const axisY = yToPx(vp, 0);
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (axisX >= 0 && axisX <= vp.width) {
    ctx.moveTo(axisX, 0);
    ctx.lineTo(axisX, vp.height);
  }
  if (axisY >= 0 && axisY <= vp.height) {
    ctx.moveTo(0, axisY);
    ctx.lineTo(vp.width, axisY);
  }
  ctx.stroke();

  // Labels along the axes (clamped to the edge when an axis is offscreen).
  ctx.fillStyle = theme.label;
  ctx.font = `${theme.fontPx}px ${theme.fontFamily}`;
  const labelY = Math.min(Math.max(axisY + 4, 4), vp.height - theme.fontPx - 4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of tickValues(vp.xMin, vp.xMax, xStep)) {
    if (v === 0) continue;
    ctx.fillText(formatTick(v, xStep), xToPx(vp, v), labelY);
  }
  const labelX = Math.min(Math.max(axisX - 6, 6), vp.width - 6);
  ctx.textAlign = axisX - 6 < 6 ? 'left' : 'right';
  ctx.textBaseline = 'middle';
  for (const v of tickValues(vp.yMin, vp.yMax, yStep)) {
    if (v === 0) continue;
    ctx.fillText(formatTick(v, yStep), labelX, yToPx(vp, v));
  }
  // Origin label, offset into the third quadrant.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  if (axisX >= 0 && axisX <= vp.width && axisY >= 0 && axisY <= vp.height) {
    ctx.fillText('0', axisX - 6, axisY + 4);
  }
}

// Points closer than this to the previously drawn point are skipped: they
// can't change the stroked shape, but they cost real time on software
// rasterizers (WebKitGTK without GPU acceleration).
const DECIMATE_PX = 0.75;

export function drawCurve(
  ctx: CanvasRenderingContext2D,
  segments: Segment[],
  style: CurveStyle,
): void {
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.widthPx;
  // bevel/butt are measurably cheaper than round on software rasterizers,
  // and indistinguishable on adaptively-sampled smooth curves.
  ctx.lineJoin = 'bevel';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const seg of segments) {
    let lx = seg[0];
    let ly = seg[1];
    ctx.moveTo(lx, ly);
    const last = seg.length - 2;
    for (let i = 2; i < last; i += 2) {
      const x = seg[i];
      const y = seg[i + 1];
      const dx = x - lx;
      const dy = y - ly;
      if (dx * dx + dy * dy < DECIMATE_PX * DECIMATE_PX) continue;
      ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
    // Segment endpoints always draw — they carry gap/asymptote geometry.
    ctx.lineTo(seg[last], seg[last + 1]);
  }
  ctx.stroke();
}
