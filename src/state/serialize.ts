// .nous serialization (M8.1). One serializer, two transports (CLAUDE.md):
// the versioned JSON written to .nous files and the base64 share code are the
// same schema — files pretty-print it, share codes compact it.
//
// Pure TypeScript: no DOM, no Tauri, no clipboard — transports live in the
// platform layer (M8.2). Deserialization treats every input as untrusted
// (pasted share codes especially): validation walks the whole tree and
// reports the path to the offending field rather than crashing.
//
// Item ids are session-local counters and are NEVER serialized. Loading
// remints every id through document.ts's mintId(), so an opened document
// can't collide with items alive in other tabs.

import type { AngleMode } from '../core/evaluator.ts';
import type { SliderMeta } from '../ui/ExpressionRow.tsx';
import type { Viewport } from '../plot/viewport.ts';
import { mintId, type ExpressionItem, type FolderItem, type GcalcDocument, type Item } from './document.ts';
import {
  defaultCurveNodes,
  MAX_CURVE_NODES,
  normalizedCurveNodes,
  SPEED_MAX,
  SPEED_MIN,
} from './sliderAnim.ts';

export const NOUS_FORMAT = 'nous';
export const NOUS_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Serialized schema (version 1)                                       */
/* ------------------------------------------------------------------ */

export interface SerializedExpression {
  kind: 'expression';
  source: string;
  colorIndex: number;
  visible: boolean;
  slider?: SliderMeta;
}

export interface SerializedFolder {
  kind: 'folder';
  name: string;
  collapsed: boolean;
  visible: boolean;
  children: SerializedItem[];
}

export type SerializedItem = SerializedExpression | SerializedFolder;

/** The saved view window. Width/height (CSS px) ride along so the x/y ranges
 * have an aspect ratio to be re-fit against; the canvas rescales to its real
 * size on mount. */
export interface SerializedViewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  width: number;
  height: number;
}

export interface NousFile {
  format: typeof NOUS_FORMAT;
  version: typeof NOUS_VERSION;
  /** Document/tab name; optional so share codes can omit it. */
  name?: string;
  angleMode: AngleMode;
  precision: number;
  viewport?: SerializedViewport;
  items: SerializedItem[];
}

/** What deserialization yields: a live document (fresh ids) plus the
 * document-adjacent state the workspace owns. */
export interface LoadedDocument {
  doc: GcalcDocument;
  name?: string;
  viewport?: Viewport;
}

/** Structured failure for malformed/unsupported input. `path` locates the
 * offending field (e.g. "items[2].children[0].source") so the UI message is
 * specific, never a bare "invalid file". */
export class NousFormatError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    // Cap the displayed path: a deeply nested document would otherwise echo
    // hundreds of `.children[0]` segments into the flash message.
    const shown =
      path !== undefined && path.length > 80 ? `${path.slice(0, 40)}…${path.slice(-24)}` : path;
    super(shown ? `${message} (at ${shown})` : message);
    this.name = 'NousFormatError';
    this.path = path;
  }
}

/* ------------------------------------------------------------------ */
/* Serialize                                                           */
/* ------------------------------------------------------------------ */

function serializeItem(item: Item): SerializedItem {
  if (item.kind === 'expression') {
    // id and the transient CAS `note` are deliberately dropped.
    const out: SerializedExpression = {
      kind: 'expression',
      source: item.source,
      colorIndex: item.colorIndex,
      visible: item.visible,
    };
    if (item.slider) {
      // Field-by-field in canonical order: the in-memory meta's key order
      // depends on UI spread history, and save→load→save must be
      // byte-identical (the stability test). The legacy M1 scalar `speed`
      // is read on load (seeding the node anchors) but never written.
      const s = item.slider;
      const slider: SliderMeta = { min: s.min, max: s.max, step: s.step };
      if (s.playing !== undefined) slider.playing = s.playing;
      if (s.speedMode !== undefined) slider.speedMode = s.speedMode;
      if (s.curveNodes !== undefined) {
        slider.curveNodes = s.curveNodes.map((n) => ({ phase: n.phase, multiplier: n.multiplier }));
      }
      if (s.loopSeam !== undefined) slider.loopSeam = s.loopSeam;
      if (s.graphSpan !== undefined) slider.graphSpan = s.graphSpan;
      if (s.animMode !== undefined) slider.animMode = s.animMode;
      out.slider = slider;
    }
    return out;
  }
  return {
    kind: 'folder',
    name: item.name,
    collapsed: item.collapsed,
    visible: item.visible,
    children: item.children.map(serializeItem),
  };
}

export function serializeDocument(
  doc: GcalcDocument,
  meta: { name?: string; viewport?: Viewport | null } = {},
): NousFile {
  const file: NousFile = {
    format: NOUS_FORMAT,
    version: NOUS_VERSION,
    angleMode: doc.angleMode,
    precision: doc.precision,
    items: doc.items.map(serializeItem),
  };
  if (meta.name !== undefined) file.name = meta.name;
  if (meta.viewport) {
    const { xMin, xMax, yMin, yMax, width, height } = meta.viewport;
    file.viewport = { xMin, xMax, yMin, yMax, width, height };
  }
  return file;
}

/** The .nous file body: pretty-printed for human-diffable saves. */
export function documentToJson(
  doc: GcalcDocument,
  meta: { name?: string; viewport?: Viewport | null } = {},
): string {
  return JSON.stringify(serializeDocument(doc, meta), null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* Validate + deserialize                                              */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectString(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new NousFormatError('expected a string', path);
  return v;
}

function expectBoolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new NousFormatError('expected true/false', path);
  return v;
}

function expectFiniteNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new NousFormatError('expected a finite number', path);
  }
  return v;
}

function parseSlider(v: unknown, path: string): SliderMeta {
  if (!isRecord(v)) throw new NousFormatError('expected a slider object', path);
  const out: SliderMeta = {
    min: expectFiniteNumber(v.min, `${path}.min`),
    max: expectFiniteNumber(v.max, `${path}.max`),
    step: expectFiniteNumber(v.step, `${path}.step`),
  };
  // Slider-Anim-M1 fields — optional so pre-animation documents load as-is.
  if (v.playing !== undefined) out.playing = expectBoolean(v.playing, `${path}.playing`);
  // Legacy M1 scalar speed: validated and used below to seed the node
  // anchors, but no longer a SliderMeta field (Slider-Anim-M3).
  let legacySpeed: number | undefined;
  if (v.speed !== undefined) {
    const speed = expectFiniteNumber(v.speed, `${path}.speed`);
    if (speed < SPEED_MIN || speed > SPEED_MAX) {
      throw new NousFormatError(`speed out of range ${SPEED_MIN}–${SPEED_MAX}`, `${path}.speed`);
    }
    legacySpeed = speed;
  }
  // Slider-Anim-M2 speed-curve fields.
  if (v.speedMode !== undefined) {
    if (v.speedMode !== 'flat' && v.speedMode !== 'curve') {
      throw new NousFormatError('expected "flat" or "curve"', `${path}.speedMode`);
    }
    out.speedMode = v.speedMode;
  }
  if (v.curveNodes !== undefined) {
    if (!Array.isArray(v.curveNodes) || v.curveNodes.length < 1 || v.curveNodes.length > MAX_CURVE_NODES) {
      throw new NousFormatError(`expected 1–${MAX_CURVE_NODES} curve nodes`, `${path}.curveNodes`);
    }
    out.curveNodes = v.curveNodes.map((node, i) => {
      const nodePath = `${path}.curveNodes[${i}]`;
      if (!isRecord(node)) throw new NousFormatError('expected a curve node object', nodePath);
      const phase = expectFiniteNumber(node.phase, `${nodePath}.phase`);
      const multiplier = expectFiniteNumber(node.multiplier, `${nodePath}.multiplier`);
      if (i === 0 ? phase !== 0 : phase <= 0 || phase > 1) {
        throw new NousFormatError(
          i === 0 ? 'the first curve node must sit at phase 0' : 'phase out of range 0–1',
          `${nodePath}.phase`,
        );
      }
      if (multiplier < SPEED_MIN || multiplier > SPEED_MAX) {
        throw new NousFormatError(
          `multiplier out of range ${SPEED_MIN}–${SPEED_MAX}`,
          `${nodePath}.multiplier`,
        );
      }
      return { phase, multiplier };
    });
    for (let i = 1; i < out.curveNodes.length; i++) {
      if (out.curveNodes[i].phase <= out.curveNodes[i - 1].phase) {
        throw new NousFormatError('curve nodes must be sorted by ascending phase', `${path}.curveNodes[${i}].phase`);
      }
    }
  }
  if (v.loopSeam !== undefined) {
    if (v.loopSeam !== 'smooth' && v.loopSeam !== 'hard') {
      throw new NousFormatError('expected "smooth" or "hard"', `${path}.loopSeam`);
    }
    out.loopSeam = v.loopSeam;
  }
  if (v.graphSpan !== undefined) {
    if (v.graphSpan !== 'oneWay' && v.graphSpan !== 'roundTrip') {
      throw new NousFormatError('expected "oneWay" or "roundTrip"', `${path}.graphSpan`);
    }
    out.graphSpan = v.graphSpan;
  }
  if (v.animMode !== undefined) {
    if (v.animMode !== 'bounce' && v.animMode !== 'loop') {
      throw new NousFormatError('expected "bounce" or "loop"', `${path}.animMode`);
    }
    out.animMode = v.animMode;
  }
  // Normalize to the M3 node model: legacy curves gain their end anchor
  // (rules that reproduce the old playback), and legacy flat speeds — or a
  // speedMode with no nodes at all — seed a constant two-anchor line. Plain
  // sliders with none of the animation fields stay minimal.
  if (out.curveNodes !== undefined) {
    out.curveNodes = normalizedCurveNodes(out);
  } else if (legacySpeed !== undefined || out.speedMode !== undefined) {
    out.curveNodes = defaultCurveNodes(legacySpeed ?? 1);
  }
  // Span-less curves are legacy (pre-M4), authored against the full-cycle
  // x-axis — pin them to 'roundTrip'. New sliders default to 'oneWay' and the
  // editor stamps the span on every edit, so this only fires for old files.
  if (out.curveNodes !== undefined && out.graphSpan === undefined) {
    out.graphSpan = 'roundTrip';
  }
  // Pair-gate (M5): roundTrip has no meaning without a return leg. The UI
  // can't produce loop+roundTrip; hand-edited files get the same forcing the
  // animMode toggle applies.
  if (out.animMode === 'loop' && out.graphSpan === 'roundTrip') {
    out.graphSpan = 'oneWay';
  }
  return out;
}

/** Deserialization recurses per folder level; a hostile document with tens of
 * thousands of nested folders would blow the call stack (found by fuzzing in
 * the M10 security pass). Far beyond anything the UI can create — reject with
 * a structured error instead of crashing. */
const MAX_FOLDER_DEPTH = 64;

function parseItem(v: unknown, path: string, depth = 0): Item {
  if (!isRecord(v)) throw new NousFormatError('expected an item object', path);
  if (v.kind === 'expression') {
    const colorIndex = expectFiniteNumber(v.colorIndex, `${path}.colorIndex`);
    if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 1_000_000) {
      throw new NousFormatError('colorIndex out of range', `${path}.colorIndex`);
    }
    const item: ExpressionItem = {
      kind: 'expression',
      id: mintId(),
      source: expectString(v.source, `${path}.source`),
      colorIndex,
      visible: expectBoolean(v.visible, `${path}.visible`),
    };
    if (v.slider !== undefined) item.slider = parseSlider(v.slider, `${path}.slider`);
    return item;
  }
  if (v.kind === 'folder') {
    if (depth >= MAX_FOLDER_DEPTH) {
      throw new NousFormatError(
        `folders nested deeper than ${MAX_FOLDER_DEPTH} levels`,
        `${path}.children`,
      );
    }
    if (!Array.isArray(v.children)) {
      throw new NousFormatError('expected a children array', `${path}.children`);
    }
    const folder: FolderItem = {
      kind: 'folder',
      id: mintId(),
      name: expectString(v.name, `${path}.name`),
      collapsed: expectBoolean(v.collapsed, `${path}.collapsed`),
      visible: expectBoolean(v.visible, `${path}.visible`),
      children: v.children.map((c, i) => parseItem(c, `${path}.children[${i}]`, depth + 1)),
    };
    return folder;
  }
  throw new NousFormatError('unknown item kind — expected "expression" or "folder"', `${path}.kind`);
}

/** World-coordinate bound for viewports. Generous (the UI zooms out to ~1e10
 * before precision degrades) but keeps absurd finite values like 1e308 out —
 * downstream tick/step math would otherwise overflow to Infinity/NaN. */
const MAX_VIEWPORT_COORD = 1e15;

function parseViewport(v: unknown, path: string): Viewport {
  if (!isRecord(v)) throw new NousFormatError('expected a viewport object', path);
  const vp: Viewport = {
    xMin: expectFiniteNumber(v.xMin, `${path}.xMin`),
    xMax: expectFiniteNumber(v.xMax, `${path}.xMax`),
    yMin: expectFiniteNumber(v.yMin, `${path}.yMin`),
    yMax: expectFiniteNumber(v.yMax, `${path}.yMax`),
    width: expectFiniteNumber(v.width, `${path}.width`),
    height: expectFiniteNumber(v.height, `${path}.height`),
  };
  if (vp.xMin >= vp.xMax || vp.yMin >= vp.yMax || vp.width <= 0 || vp.height <= 0) {
    throw new NousFormatError('viewport ranges must be non-empty', path);
  }
  const worldBounds = [vp.xMin, vp.xMax, vp.yMin, vp.yMax];
  if (worldBounds.some((c) => Math.abs(c) > MAX_VIEWPORT_COORD) || vp.width > 1e6 || vp.height > 1e6) {
    throw new NousFormatError('viewport out of range', path);
  }
  return vp;
}

/** Validate a parsed JSON value as a .nous document and build a live
 * GcalcDocument from it (every id freshly minted). */
export function loadNousValue(value: unknown): LoadedDocument {
  if (!isRecord(value)) throw new NousFormatError('expected a JSON object');
  if (value.format !== NOUS_FORMAT) {
    throw new NousFormatError('not a .nous document — missing `"format": "nous"`', 'format');
  }
  const version = expectFiniteNumber(value.version, 'version');
  if (version !== NOUS_VERSION) {
    throw new NousFormatError(
      `unsupported .nous version ${version} — this build reads version ${NOUS_VERSION}`,
      'version',
    );
  }
  const angleMode = value.angleMode;
  if (angleMode !== 'radians' && angleMode !== 'degrees') {
    throw new NousFormatError('expected "radians" or "degrees"', 'angleMode');
  }
  const precision = expectFiniteNumber(value.precision, 'precision');
  if (!Number.isInteger(precision) || precision < 1 || precision > 15) {
    throw new NousFormatError('precision must be an integer between 1 and 15', 'precision');
  }
  if (!Array.isArray(value.items)) throw new NousFormatError('expected an items array', 'items');

  const out: LoadedDocument = {
    doc: {
      items: value.items.map((it, i) => parseItem(it, `items[${i}]`)),
      angleMode,
      precision,
    },
  };
  if (value.name !== undefined) out.name = expectString(value.name, 'name');
  if (value.viewport !== undefined) out.viewport = parseViewport(value.viewport, 'viewport');
  return out;
}

/** Parse a .nous file body. */
export function parseNousJson(text: string): LoadedDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new NousFormatError(
      `not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return loadNousValue(value);
}

/* ------------------------------------------------------------------ */
/* Share codes: compact JSON → UTF-8 → base64                          */
/* ------------------------------------------------------------------ */

// Hand-rolled base64 keeps this module dependency-free and identical across
// Node (tests) and the WebView — no btoa (Latin-1 only) or Buffer (Node only).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Map([...B64].map((c, i) => [c, i] as const));

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 4 !== 0) throw new NousFormatError('share code is truncated');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const q = [0, 1, 2, 3].map((k) => {
      const ch = clean[i + k];
      if (ch === '=') return 0;
      const v = B64_REV.get(ch);
      if (v === undefined) throw new NousFormatError('share code contains invalid characters');
      return v;
    });
    const n = (q[0] << 18) | (q[1] << 12) | (q[2] << 6) | q[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Compact-serialize + base64: the "Copy Share Code" payload. */
export function encodeShareCode(
  doc: GcalcDocument,
  meta: { name?: string; viewport?: Viewport | null } = {},
): string {
  const json = JSON.stringify(serializeDocument(doc, meta));
  return bytesToBase64(new TextEncoder().encode(json));
}

/** Decode + validate a pasted share code. Throws NousFormatError on any
 * malformed input; never leaves partial state behind (pure function). */
export function decodeShareCode(code: string): LoadedDocument {
  const trimmed = code.trim();
  if (trimmed === '') throw new NousFormatError('share code is empty');
  const bytes = base64ToBytes(trimmed);
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new NousFormatError('share code does not decode to text');
  }
  return parseNousJson(json);
}
