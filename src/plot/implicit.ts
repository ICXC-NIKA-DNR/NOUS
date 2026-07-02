// Implicit curves and inequality regions on a viewport grid.
//
// contour():   marching squares over F(x, y) = 0 — emits screen-space line
//              segments with linear interpolation along cell edges.
// regionMask():per-cell membership for an inequality, as an alpha buffer the
//              renderer scales up (soft edges are fine — the stroked contour
//              of the boundary crisps the silhouette).
//
// NaN cells never contour and never shade — that's how domain restrictions
// gate these plot types (the condition multiplies into the closures as NaN).

import type { Segment } from './sampler.ts';
import { pxToX, pxToY, type Viewport } from './viewport.ts';

/** Marching-squares contour of F = 0. Returns 2-point screen-px segments. */
export function contour(
  F: (x: number, y: number) => number,
  vp: Viewport,
  cellPx = 4,
): Segment[] {
  const cols = Math.max(2, Math.ceil(vp.width / cellPx));
  const rows = Math.max(2, Math.ceil(vp.height / cellPx));
  const stepX = vp.width / cols;
  const stepY = vp.height / rows;

  // Grid node values, row-major (rows+1) x (cols+1).
  const values = new Float64Array((rows + 1) * (cols + 1));
  for (let j = 0; j <= rows; j++) {
    const wy = pxToY(vp, j * stepY);
    for (let i = 0; i <= cols; i++) {
      values[j * (cols + 1) + i] = F(pxToX(vp, i * stepX), wy);
    }
  }

  const segments: Segment[] = [];

  /** Interpolated zero-crossing position between two nodes (0..1). */
  const cross = (a: number, b: number): number => {
    const t = a / (a - b);
    return t >= 0 && t <= 1 ? t : 0.5;
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const tl = values[j * (cols + 1) + i];
      const tr = values[j * (cols + 1) + i + 1];
      const br = values[(j + 1) * (cols + 1) + i + 1];
      const bl = values[(j + 1) * (cols + 1) + i];
      if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) {
        continue;
      }

      let caseId = 0;
      if (tl < 0) caseId |= 8;
      if (tr < 0) caseId |= 4;
      if (br < 0) caseId |= 2;
      if (bl < 0) caseId |= 1;
      if (caseId === 0 || caseId === 15) continue;

      const x0 = i * stepX;
      const y0 = j * stepY;
      // Edge midcrossings: top, right, bottom, left.
      const top: [number, number] = [x0 + cross(tl, tr) * stepX, y0];
      const right: [number, number] = [x0 + stepX, y0 + cross(tr, br) * stepY];
      const bottom: [number, number] = [x0 + cross(bl, br) * stepX, y0 + stepY];
      const left: [number, number] = [x0, y0 + cross(tl, bl) * stepY];

      const add = (p: [number, number], q: [number, number]): void => {
        segments.push([p[0], p[1], q[0], q[1]]);
      };

      switch (caseId) {
        case 1:
        case 14:
          add(left, bottom);
          break;
        case 2:
        case 13:
          add(bottom, right);
          break;
        case 3:
        case 12:
          add(left, right);
          break;
        case 4:
        case 11:
          add(top, right);
          break;
        case 6:
        case 9:
          add(top, bottom);
          break;
        case 7:
        case 8:
          add(left, top);
          break;
        case 5:
        case 10: {
          // Saddle: disambiguate with the cell-center sample.
          const cx = pxToX(vp, x0 + stepX / 2);
          const cy = pxToY(vp, y0 + stepY / 2);
          const center = F(cx, cy);
          const centerNeg = center < 0;
          if (caseId === 5) {
            if (centerNeg) {
              add(left, top);
              add(bottom, right);
            } else {
              add(left, bottom);
              add(top, right);
            }
          } else {
            if (centerNeg) {
              add(top, right);
              add(left, bottom);
            } else {
              add(left, top);
              add(bottom, right);
            }
          }
          break;
        }
      }
    }
  }

  return segments;
}

export interface RegionMask {
  cols: number;
  rows: number;
  /** 1 byte per cell: 255 = inside, 0 = outside/undefined. */
  cells: Uint8Array;
}

/** Per-cell membership of an inequality region, sampled at cell centers. */
export function regionMask(
  inside: (x: number, y: number) => boolean,
  vp: Viewport,
  cellPx = 3,
): RegionMask {
  const cols = Math.max(2, Math.ceil(vp.width / cellPx));
  const rows = Math.max(2, Math.ceil(vp.height / cellPx));
  const stepX = vp.width / cols;
  const stepY = vp.height / rows;
  const cells = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const wy = pxToY(vp, (j + 0.5) * stepY);
    for (let i = 0; i < cols; i++) {
      if (inside(pxToX(vp, (i + 0.5) * stepX), wy)) cells[j * cols + i] = 255;
    }
  }
  return { cols, rows, cells };
}
