// SVG export (M8.4). Builds a self-contained vector image of the current
// view: background, grid/axes/labels (same tick math as the canvas renderer),
// then curves as real <path> elements — no embedded rasters.
//
// Pure TypeScript (string building only): callers hand geometry in screen
// pixels, already sampled by the same engines that feed the canvas, so the
// exported SVG matches what's on screen.
//
// One deliberate divergence from the canvas: inequality REGION FILLS are
// rasters on canvas (marching-squares masks) and are omitted here; a region's
// boundary curves still export as (dashed, for strict) vector paths.

import type { Segment } from './sampler.ts';
import { tickStep, tickValues, formatTick } from './ticks.ts';
import { xToPx, yToPx, type Viewport } from './viewport.ts';
import type { Theme } from './render.ts';

export type SvgElement =
  | { kind: 'path'; color: string; widthPx: number; dash?: number[]; segments: Segment[] }
  | { kind: 'point'; color: string; px: number; py: number }
  | { kind: 'arrow'; color: string; x0: number; y0: number; x1: number; y1: number; widthPx: number };

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => XML_ESCAPES[c]);
}

/** Trim float noise; SVG coordinates don't need sub-hundredth precision. */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// Same skip threshold as the canvas renderer (render.ts): points that can't
// change the stroked shape only bloat the file.
const DECIMATE_PX = 0.75;

function pathData(segments: Segment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.length < 4) continue;
    let lx = seg[0];
    let ly = seg[1];
    parts.push(`M${n(lx)} ${n(ly)}`);
    const last = seg.length - 2;
    for (let i = 2; i < last; i += 2) {
      const x = seg[i];
      const y = seg[i + 1];
      const dx = x - lx;
      const dy = y - ly;
      if (dx * dx + dy * dy < DECIMATE_PX * DECIMATE_PX) continue;
      parts.push(`L${n(x)} ${n(y)}`);
      lx = x;
      ly = y;
    }
    parts.push(`L${n(seg[last])} ${n(seg[last + 1])}`);
  }
  return parts.join('');
}

function arrowMarkup(a: Extract<SvgElement, { kind: 'arrow' }>): string {
  // Mirrors drawArrow in marks.ts: shaft stops short of the tip, filled head.
  const dx = a.x1 - a.x0;
  const dy = a.y1 - a.y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return '';
  const head = Math.min(10, 4 + len * 0.12);
  const ux = dx / len;
  const uy = dy / len;
  const shaft =
    `<line x1="${n(a.x0)}" y1="${n(a.y0)}" x2="${n(a.x1 - ux * head * 0.8)}" ` +
    `y2="${n(a.y1 - uy * head * 0.8)}" stroke="${esc(a.color)}" stroke-width="${a.widthPx}"/>`;
  const headPts =
    `${n(a.x1)},${n(a.y1)} ` +
    `${n(a.x1 - ux * head - uy * head * 0.45)},${n(a.y1 - uy * head + ux * head * 0.45)} ` +
    `${n(a.x1 - ux * head + uy * head * 0.45)},${n(a.y1 - uy * head - ux * head * 0.45)}`;
  return `${shaft}<polygon points="${headPts}" fill="${esc(a.color)}"/>`;
}

function gridMarkup(vp: Viewport, theme: Theme): string {
  const xStep = tickStep(vp.xMax - vp.xMin, vp.width);
  const yStep = tickStep(vp.yMax - vp.yMin, vp.height);
  const minorDiv = (step: number): number => {
    const mant = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    return Math.round(mant) === 2 ? 4 : 5;
  };

  const lines = (xs: number[], ys: number[], color: string, width: number): string => {
    let d = '';
    for (const v of xs) {
      const px = Math.round(xToPx(vp, v)) + 0.5;
      d += `M${n(px)} 0V${n(vp.height)}`;
    }
    for (const v of ys) {
      const py = Math.round(yToPx(vp, v)) + 0.5;
      d += `M0 ${n(py)}H${n(vp.width)}`;
    }
    return d === '' ? '' : `<path d="${d}" stroke="${esc(color)}" stroke-width="${width}" fill="none"/>`;
  };

  let out = lines(
    tickValues(vp.xMin, vp.xMax, xStep / minorDiv(xStep)),
    tickValues(vp.yMin, vp.yMax, yStep / minorDiv(yStep)),
    theme.gridMinor,
    1,
  );
  out += lines(tickValues(vp.xMin, vp.xMax, xStep), tickValues(vp.yMin, vp.yMax, yStep), theme.grid, 1);

  // Axes.
  const axisX = xToPx(vp, 0);
  const axisY = yToPx(vp, 0);
  let axes = '';
  if (axisX >= 0 && axisX <= vp.width) axes += `M${n(axisX)} 0V${n(vp.height)}`;
  if (axisY >= 0 && axisY <= vp.height) axes += `M0 ${n(axisY)}H${n(vp.width)}`;
  if (axes !== '') out += `<path d="${axes}" stroke="${esc(theme.axis)}" stroke-width="1.5" fill="none"/>`;

  // Labels — same clamping as the canvas grid.
  const font = `font-family="${esc(theme.fontFamily)}" font-size="${theme.fontPx}" fill="${esc(theme.label)}"`;
  const labelY = Math.min(Math.max(axisY + 4, 4), vp.height - theme.fontPx - 4);
  for (const v of tickValues(vp.xMin, vp.xMax, xStep)) {
    if (v === 0) continue;
    out += `<text x="${n(xToPx(vp, v))}" y="${n(labelY)}" text-anchor="middle" dominant-baseline="hanging" ${font}>${esc(formatTick(v, xStep))}</text>`;
  }
  const labelX = Math.min(Math.max(axisX - 6, 6), vp.width - 6);
  const anchor = axisX - 6 < 6 ? 'start' : 'end';
  for (const v of tickValues(vp.yMin, vp.yMax, yStep)) {
    if (v === 0) continue;
    out += `<text x="${n(labelX)}" y="${n(yToPx(vp, v))}" text-anchor="${anchor}" dominant-baseline="middle" ${font}>${esc(formatTick(v, yStep))}</text>`;
  }
  if (axisX >= 0 && axisX <= vp.width && axisY >= 0 && axisY <= vp.height) {
    out += `<text x="${n(axisX - 6)}" y="${n(axisY + 4)}" text-anchor="end" dominant-baseline="hanging" ${font}>0</text>`;
  }
  return out;
}

export function buildSvg(
  vp: Viewport,
  theme: Theme,
  background: string,
  elements: SvgElement[],
  opts: { grid?: boolean } = {},
): string {
  const w = Math.round(vp.width);
  const h = Math.round(vp.height);
  let body = `<rect width="${w}" height="${h}" fill="${esc(background)}"/>`;
  if (opts.grid !== false) body += gridMarkup(vp, theme);

  for (const el of elements) {
    if (el.kind === 'path') {
      const d = pathData(el.segments);
      if (d === '') continue;
      const dash = el.dash ? ` stroke-dasharray="${el.dash.join(' ')}"` : '';
      body +=
        `<path d="${d}" stroke="${esc(el.color)}" stroke-width="${el.widthPx}"` +
        ` fill="none" stroke-linejoin="bevel" stroke-linecap="butt"${dash}/>`;
    } else if (el.kind === 'point') {
      body += `<circle cx="${n(el.px)}" cy="${n(el.py)}" r="4" fill="${esc(el.color)}"/>`;
    } else {
      body += arrowMarkup(el);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `width="${w}" height="${h}">${body}</svg>\n`
  );
}
