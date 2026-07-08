// Autosave session payload (M8.3). Packs every open tab — same per-document
// schema as .nous files (serialize.ts), wrapped in a session envelope — so
// crash recovery restores the whole workspace, not just one graph.
//
// Pure TypeScript; the storage transport (localStorage) lives in
// platform/autosave.ts.

import type { Viewport } from '../plot/viewport.ts';
import type { GcalcDocument } from './document.ts';
import {
  loadNousValue,
  NousFormatError,
  serializeDocument,
  type LoadedDocument,
  type NousFile,
} from './serialize.ts';

export const SESSION_FORMAT = 'nous-session';
export const SESSION_VERSION = 1;

export interface SessionTab {
  name: string;
  doc: GcalcDocument;
  viewport: Viewport | null;
}

interface SessionEnvelope {
  format: typeof SESSION_FORMAT;
  version: typeof SESSION_VERSION;
  savedAt: number;
  tabs: NousFile[];
}

export interface UnpackedSession {
  savedAt: number;
  tabs: LoadedDocument[];
}

export function packSession(tabs: SessionTab[], savedAt = Date.now()): string {
  const envelope: SessionEnvelope = {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt,
    tabs: tabs.map((t) => serializeDocument(t.doc, { name: t.name, viewport: t.viewport })),
  };
  return JSON.stringify(envelope);
}

/** Validate + unpack an autosave payload; ids are reminted per document.
 * Throws NousFormatError on anything malformed (a half-written payload from a
 * crash mid-write must be rejected, not half-restored). */
export function unpackSession(text: string): UnpackedSession {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NousFormatError('autosave payload is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NousFormatError('autosave payload is not an object');
  }
  const v = value as Record<string, unknown>;
  if (v.format !== SESSION_FORMAT || v.version !== SESSION_VERSION) {
    throw new NousFormatError('not a recognized autosave payload');
  }
  if (typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt)) {
    throw new NousFormatError('autosave payload has no timestamp');
  }
  if (!Array.isArray(v.tabs) || v.tabs.length === 0) {
    throw new NousFormatError('autosave payload has no tabs');
  }
  return { savedAt: v.savedAt, tabs: v.tabs.map(loadNousValue) };
}
