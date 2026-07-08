// Shortcut matching (M9.3): the BINDINGS table drives both the handler and
// the reference panel; matching honours modifiers and the typing guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDINGS, matchShortcut, type KeyLike } from '../shortcuts.ts';

const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  typing: false,
  ...mods,
});

test('undo/redo chords (Ctrl and Cmd, plus Ctrl+Y)', () => {
  assert.equal(matchShortcut(ev('z', { ctrlKey: true })), 'undo');
  assert.equal(matchShortcut(ev('Z', { metaKey: true, shiftKey: true })), 'redo');
  assert.equal(matchShortcut(ev('y', { ctrlKey: true })), 'redo');
});

test('document and view shortcuts', () => {
  assert.equal(matchShortcut(ev('Enter', { ctrlKey: true })), 'new-expression');
  assert.equal(matchShortcut(ev('Backspace', { metaKey: true })), 'delete-expression');
  assert.equal(matchShortcut(ev('h', { ctrlKey: true })), 'toggle-visibility');
  assert.equal(matchShortcut(ev('=', { ctrlKey: true })), 'zoom-in');
  assert.equal(matchShortcut(ev('+', { ctrlKey: true, shiftKey: true })), 'zoom-in');
  assert.equal(matchShortcut(ev('-', { ctrlKey: true })), 'zoom-out');
  assert.equal(matchShortcut(ev('0', { ctrlKey: true })), 'zoom-reset');
});

test('? opens the reference, but never while typing', () => {
  assert.equal(matchShortcut(ev('?', { shiftKey: true })), 'show-shortcuts');
  assert.equal(matchShortcut(ev('?', { shiftKey: true, typing: true })), null);
});

test('bare keys never fire while typing; plain typing matches nothing', () => {
  assert.equal(matchShortcut(ev('h')), null);
  assert.equal(matchShortcut(ev('Enter')), null);
  assert.equal(matchShortcut(ev('Backspace', { typing: true })), null);
  assert.equal(matchShortcut(ev('a', { typing: true })), null);
});

test('every listed action is reachable from its displayed binding', () => {
  // Sanity: table rows aren't dead entries the matcher can't produce.
  const reachable = new Set([
    matchShortcut(ev('Enter', { ctrlKey: true })),
    matchShortcut(ev('Backspace', { ctrlKey: true })),
    matchShortcut(ev('h', { ctrlKey: true })),
    matchShortcut(ev('z', { ctrlKey: true })),
    matchShortcut(ev('y', { ctrlKey: true })),
    matchShortcut(ev('=', { ctrlKey: true })),
    matchShortcut(ev('-', { ctrlKey: true })),
    matchShortcut(ev('0', { ctrlKey: true })),
    matchShortcut(ev('?', { shiftKey: true })),
  ]);
  for (const b of BINDINGS) {
    assert.ok(reachable.has(b.action), `${b.action} unreachable from its binding`);
  }
});
