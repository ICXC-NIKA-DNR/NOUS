// SVG export (M8.4): the builder must emit self-contained, well-formed
// vector markup — real <path> elements, no rasters — matching the canvas
// renderer's geometry conventions (decimation, dash patterns, tick layout).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSvg, type SvgElement } from '../exportSvg.ts';
import type { Theme } from '../render.ts';
import type { Viewport } from '../viewport.ts';

const vp: Viewport = { xMin: -10, xMax: 10, yMin: -10, yMax: 10, width: 400, height: 400 };
const theme: Theme = {
  grid: '#34373d',
  gridMinor: '#26282d',
  axis: '#5a5e66',
  label: '#9a9da5',
  fontPx: 11,
  fontFamily: 'Inter, sans-serif',
};

test('emits a standalone svg with background, grid, axes, and labels', () => {
  const svg = buildSvg(vp, theme, '#1b1d21', []);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 400 400"/);
  assert.match(svg, /<rect width="400" height="400" fill="#1b1d21"\/>/);
  assert.match(svg, /stroke="#34373d"/); // major grid
  assert.match(svg, /stroke="#5a5e66"/); // axes
  assert.match(svg, />5<\/text>/); // a tick label
  assert.match(svg, /<\/svg>\n$/);
});

test('grid can be omitted', () => {
  const svg = buildSvg(vp, theme, '#1b1d21', [], { grid: false });
  assert.doesNotMatch(svg, /<text/);
  assert.doesNotMatch(svg, /stroke="#34373d"/);
});

test('curve segments become stroked paths with decimation', () => {
  // 100 collinear points 0.1px apart: decimation keeps ends, drops middles.
  const seg: number[] = [];
  for (let i = 0; i <= 100; i++) seg.push(i * 0.1, 200);
  const els: SvgElement[] = [{ kind: 'path', color: '#8ab4f8', widthPx: 2, segments: [seg] }];
  const svg = buildSvg(vp, theme, '#000', els, { grid: false });
  const d = /<path d="([^"]+)" stroke="#8ab4f8"/.exec(svg)?.[1];
  assert.ok(d, 'curve path present');
  assert.match(d, /^M0 200/);
  assert.match(d, /L10 200$/);
  assert.ok(d.split('L').length < 30, `expected decimation, got ${d.split('L').length} points`);
  assert.match(svg, /fill="none"/);
});

test('multi-segment curves emit one path with multiple subpaths (gaps preserved)', () => {
  const els: SvgElement[] = [
    { kind: 'path', color: '#fff', widthPx: 2, segments: [[0, 0, 50, 50], [100, 100, 150, 150]] },
  ];
  const svg = buildSvg(vp, theme, '#000', els, { grid: false });
  const d = /<path d="([^"]+)" stroke="#fff"/.exec(svg)?.[1];
  assert.equal(d?.split('M').filter(Boolean).length, 2);
});

test('dashed boundaries, points, and arrows render as vector primitives', () => {
  const els: SvgElement[] = [
    { kind: 'path', color: '#f28b82', widthPx: 1.75, dash: [6, 5], segments: [[0, 0, 100, 100]] },
    { kind: 'point', color: '#8ab4f8', px: 42, py: 43 },
    { kind: 'arrow', color: '#a5d6a7', x0: 10, y0: 10, x1: 60, y1: 60, widthPx: 2 },
  ];
  const svg = buildSvg(vp, theme, '#000', els, { grid: false });
  assert.match(svg, /stroke-dasharray="6 5"/);
  assert.match(svg, /<circle cx="42" cy="43" r="4" fill="#8ab4f8"\/>/);
  assert.match(svg, /<line [^>]*stroke="#a5d6a7"/);
  assert.match(svg, /<polygon [^>]*fill="#a5d6a7"/);
  assert.doesNotMatch(svg, /<image/); // no embedded rasters, ever
});

test('escapes markup-significant characters in colors/fonts/labels', () => {
  const svg = buildSvg(vp, { ...theme, fontFamily: '"Weird & Font" <sans>' }, '#000', []);
  assert.doesNotMatch(svg, /font-family="[^"]*</);
  assert.match(svg, /&amp; Font/);
});

test('degenerate segments (single sample) are skipped, not emitted as invalid paths', () => {
  const els: SvgElement[] = [{ kind: 'path', color: '#fff', widthPx: 2, segments: [[5, 5]] }];
  const svg = buildSvg(vp, theme, '#000', els, { grid: false });
  assert.doesNotMatch(svg, /stroke="#fff"/);
});
