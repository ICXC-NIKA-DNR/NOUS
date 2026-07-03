// Structured errors. Every user-facing error should, where possible, carry a
// Suggestion the UI can render as a one-click fix (see CLAUDE.md).

import type { Span } from './ast.ts';

/** A concrete text edit the UI can apply to the source expression. */
export type Edit =
  | { type: 'insert'; at: number; text: string }
  | { type: 'replace'; span: Span; text: string };

export interface Suggestion {
  /** Human-readable label, e.g. `Insert ")"` or `Did you mean sin?` */
  label: string;
  /** Present when the fix is a pure text edit. */
  edit?: Edit;
  /**
   * Present when the fix is an app action rather than a text edit.
   * 'create-slider' → offer to turn the undefined variable into a slider.
   */
  action?: 'create-slider';
  /** Variable name for action suggestions. */
  name?: string;
}

export type DiagnosticKind =
  | 'empty-input'
  | 'invalid-number'
  | 'unexpected-token'
  | 'unexpected-end'
  | 'unmatched-paren'
  | 'extra-paren'
  | 'unknown-function'
  | 'missing-argument'
  | 'wrong-arity'
  | 'undefined-variable'
  | 'not-a-condition'
  | 'not-a-value'
  | 'unterminated-abs'
  | 'cas-unsupported';

export interface Diagnostic {
  kind: DiagnosticKind;
  message: string;
  span: Span;
  suggestion?: Suggestion;
}

export class GcalcError extends Error {
  readonly info: Diagnostic;
  constructor(info: Diagnostic) {
    super(info.message);
    this.name = 'GcalcError';
    this.info = info;
  }
}

export function fail(info: Diagnostic): never {
  throw new GcalcError(info);
}

/* ------------------------------------------------------------------ */
/* Nearest-name lookup (Damerau–Levenshtein, so transpositions cost 1) */
/* ------------------------------------------------------------------ */

export function damerau(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** Distance threshold: short words tolerate 1 edit, longer words 2. */
export function nameThreshold(word: string): number {
  return word.length <= 4 ? 1 : 2;
}

/** Closest candidate within threshold, or null. */
export function nearestName(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = damerau(word, c);
    if (dist < bestDist || (dist === bestDist && best !== null && c.length < best.length)) {
      best = c;
      bestDist = dist;
    }
  }
  return best !== null && bestDist <= nameThreshold(word) ? best : null;
}
