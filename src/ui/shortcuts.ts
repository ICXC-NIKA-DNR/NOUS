// Keyboard shortcuts (M9.3). One table drives BOTH the global key handler
// (App.tsx) and the reference panel — they can never drift apart.
//
// Pure module: matching takes a plain event-shaped object, so it's
// node:test-able without a DOM.

export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'new-expression'
  | 'delete-expression'
  | 'toggle-visibility'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'show-shortcuts';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True when focus is in a text-editing element. */
  typing: boolean;
}

interface Binding {
  action: ShortcutAction;
  /** Display string for the reference panel (Ctrl shown; Cmd works too). */
  display: string;
  description: string;
  /** Keys (lowercase, KeyboardEvent.key) this binding matches. */
  keys: string[];
  ctrl: boolean;
  shift?: boolean;
  /** Allowed while typing in an input (all Ctrl-chords are; bare keys aren't). */
  whileTyping: boolean;
}

/** Display order here = panel order. Ctrl means Ctrl or Cmd. */
export const BINDINGS: readonly Binding[] = [
  { action: 'new-expression', display: 'Ctrl+Enter', description: 'New expression', keys: ['enter'], ctrl: true, whileTyping: true },
  { action: 'delete-expression', display: 'Ctrl+Backspace', description: 'Delete current expression', keys: ['backspace'], ctrl: true, whileTyping: true },
  { action: 'toggle-visibility', display: 'Ctrl+H', description: 'Show/hide current curve', keys: ['h'], ctrl: true, whileTyping: true },
  { action: 'undo', display: 'Ctrl+Z', description: 'Undo', keys: ['z'], ctrl: true, shift: false, whileTyping: true },
  { action: 'redo', display: 'Ctrl+Shift+Z / Ctrl+Y', description: 'Redo', keys: ['y'], ctrl: true, whileTyping: true },
  { action: 'zoom-in', display: 'Ctrl+=', description: 'Zoom in', keys: ['=', '+'], ctrl: true, whileTyping: true },
  { action: 'zoom-out', display: 'Ctrl+-', description: 'Zoom out', keys: ['-'], ctrl: true, whileTyping: true },
  { action: 'zoom-reset', display: 'Ctrl+0', description: 'Reset view', keys: ['0'], ctrl: true, whileTyping: true },
  { action: 'show-shortcuts', display: '?', description: 'Show this reference', keys: ['?'], ctrl: false, whileTyping: false },
];

// Redo's second chord (Ctrl+Shift+Z) matches the undo key with shift held —
// handled explicitly in match() rather than duplicated in the table.

/** Match a key event to an action, or null. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  const key = e.key.toLowerCase();
  const chord = e.ctrlKey || e.metaKey;
  if (chord && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  for (const b of BINDINGS) {
    if (b.action === 'undo' || b.action === 'redo') continue; // handled above (except Ctrl+Y)
    if (!b.keys.includes(key)) continue;
    if (b.ctrl !== chord) continue;
    if (b.shift !== undefined && b.shift !== e.shiftKey) continue;
    if (e.typing && !b.whileTyping) continue;
    return b.action;
  }
  if (chord && key === 'y') return 'redo';
  return null;
}
