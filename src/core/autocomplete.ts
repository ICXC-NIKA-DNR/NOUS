// Autocomplete engine (M9.1). Pure: (source text, caret, names in scope) →
// ranked completion list plus the [from,to) span the accepted insert
// replaces. All rendering/keyboard handling lives in the UI; this module owns
// what is offered and what accepting does to the text.
//
// Vocabulary comes from names.ts (the one function/constant table — never a
// second hardcoded list) plus caller-supplied names defined in the document.

import { CONSTANTS, FUNCTION_NAMES } from './names.ts';

export interface Completion {
  /** Bare name, e.g. "sin". */
  name: string;
  /** What the UI shows, e.g. "sin(". */
  label: string;
  /** Replacement text for the [from,to) span. */
  insert: string;
  /** Caret position within `insert` after accepting. */
  caretOffset: number;
  kind: 'function' | 'constant' | 'defined';
}

export interface CompletionResult {
  /** Span of the identifier prefix being completed. */
  from: number;
  to: number;
  items: Completion[];
}

/** Templates callable like functions but not in FUNCTION_NAMES (analyze.ts's
 * EXTRA_FUNCTIONS). Kept here so the vocabulary stays in one module. */
export const TEMPLATE_FUNCTIONS: readonly string[] = ['derivative', 'integral', 'vector'];

const MAX_ITEMS = 8;

function isLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isIdentChar(c: string): boolean {
  return isLetter(c) || (c >= '0' && c <= '9');
}

/** The identifier prefix ending at `caret`, or null when there isn't one
 * (caret mid-word, after a digit-run only, etc.). */
function prefixAt(source: string, caret: number): { from: number; text: string } | null {
  if (caret < 1 || caret > source.length) return null;
  // Completing mid-identifier (caret followed by more word chars) is noise.
  if (caret < source.length && isIdentChar(source[caret])) return null;
  let start = caret;
  while (start > 0 && isIdentChar(source[start - 1])) start--;
  // Trim leading digits: `2sin` segments as 2·sin, the prefix is `sin`.
  while (start < caret && !isLetter(source[start])) start++;
  if (start === caret) return null;
  return { from: start, text: source.slice(start, caret) };
}

function functionCompletion(name: string, kind: Completion['kind']): Completion {
  return { name, label: `${name}(`, insert: `${name}(`, caretOffset: name.length + 1, kind };
}

function nameCompletion(name: string, kind: Completion['kind']): Completion {
  return { name, label: name, insert: name, caretOffset: name.length, kind };
}

/**
 * Completions for the identifier prefix at `caret`, or null when nothing
 * should be offered. `definedNames` are the document's slider/value names
 * (inserted bare); `definedFunctions` are user-defined function names
 * (inserted with `(`, caret inside — M9.5). Both rank ahead of built-ins.
 */
export function complete(
  source: string,
  caret: number,
  definedNames: Iterable<string> = [],
  definedFunctions: Iterable<string> = [],
): CompletionResult | null {
  const prefix = prefixAt(source, caret);
  if (prefix === null) return null;

  // Assemble the vocabulary. User names first so they win dedupe.
  const vocabulary = new Map<string, Completion>();
  for (const n of definedFunctions) {
    if (n !== '' && !vocabulary.has(n)) vocabulary.set(n, functionCompletion(n, 'defined'));
  }
  for (const n of definedNames) {
    if (n !== '' && !vocabulary.has(n)) vocabulary.set(n, nameCompletion(n, 'defined'));
  }
  for (const n of FUNCTION_NAMES) {
    if (!vocabulary.has(n)) vocabulary.set(n, functionCompletion(n, 'function'));
  }
  for (const n of TEMPLATE_FUNCTIONS) {
    if (!vocabulary.has(n)) vocabulary.set(n, functionCompletion(n, 'function'));
  }
  for (const n of Object.keys(CONSTANTS)) {
    if (!vocabulary.has(n)) vocabulary.set(n, nameCompletion(n, 'constant'));
  }

  const p = prefix.text.toLowerCase();
  const starts: Completion[] = [];
  const contains: Completion[] = [];
  for (const item of vocabulary.values()) {
    const n = item.name.toLowerCase();
    if (n === p && item.insert === item.name) continue; // nothing to add
    if (n.startsWith(p)) starts.push(item);
    else if (p.length >= 2 && n.includes(p)) contains.push(item);
  }

  const byLengthThenAlpha = (a: Completion, b: Completion): number =>
    a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  starts.sort(byLengthThenAlpha);
  contains.sort(byLengthThenAlpha);

  const items = [...starts, ...contains].slice(0, MAX_ITEMS);
  if (items.length === 0) return null;
  return { from: prefix.from, to: caret, items };
}

/** Apply an accepted completion: new source text + absolute caret position. */
export function applyCompletion(
  source: string,
  result: CompletionResult,
  item: Completion,
): { source: string; caret: number } {
  return {
    source: source.slice(0, result.from) + item.insert + source.slice(result.to),
    caret: result.from + item.caretOffset,
  };
}
