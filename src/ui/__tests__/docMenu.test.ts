// File-menu behavior (M11): every action, toast, and close path of the
// dropdown that replaced the DocActions row — driven through the DOM-free
// controller in ui/docMenu.ts with injected save/open/clipboard fakes.
// The Escape and outside-click handlers in DocActions.tsx both call
// closeMenu(); its reset semantics are what's under test here.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocMenuController, type DocMenuDeps, type DocMenuState } from '../docMenu.ts';
import { NousFormatError } from '../../state/serialize.ts';

interface Harness {
  ctrl: DocMenuController;
  flashes: Array<{ text: string; error: boolean }>;
  /** menuOpen at the moment each flash fired — toast/menu independence. */
  openAtFlash: boolean[];
  states: DocMenuState[];
}

function makeHarness(overrides: Partial<DocMenuDeps> = {}): Harness {
  const flashes: Harness['flashes'] = [];
  const openAtFlash: boolean[] = [];
  const states: DocMenuState[] = [];
  const deps: DocMenuDeps = {
    makeShareCode: () => 'CODE123',
    openShareCode: () => {},
    saveFile: () => Promise.resolve('graph.nous'),
    openFile: () => Promise.resolve('graph.nous'),
    writeClipboard: () => Promise.resolve(),
    flash: (text, error = false) => {
      flashes.push({ text, error });
      openAtFlash.push(ctrl.state.menuOpen);
    },
    ...overrides,
  };
  const ctrl = new DocMenuController(
    () => deps,
    (s) => states.push(s),
  );
  return { ctrl, flashes, openAtFlash, states };
}

test('toggleMenu opens and closes; notify mirrors state', () => {
  const h = makeHarness();
  assert.equal(h.ctrl.state.menuOpen, false);
  h.ctrl.toggleMenu();
  assert.equal(h.ctrl.state.menuOpen, true);
  h.ctrl.toggleMenu();
  assert.equal(h.ctrl.state.menuOpen, false);
  assert.deepEqual(
    h.states.map((s) => s.menuOpen),
    [true, false],
  );
});

test('closeMenu (Escape / outside click) resets the paste panel too', () => {
  const h = makeHarness();
  h.ctrl.toggleMenu();
  h.ctrl.togglePaste();
  h.ctrl.setPasteText('half-typed code');
  h.ctrl.closeMenu();
  assert.deepEqual(h.ctrl.state, { menuOpen: false, pasteOpen: false, pasteText: '' });
});

test('save: menu closes immediately, success toasts the file name', async () => {
  const h = makeHarness();
  h.ctrl.toggleMenu();
  const done = h.ctrl.save();
  assert.equal(h.ctrl.state.menuOpen, false); // closed before the dialog resolves
  await done;
  assert.deepEqual(h.flashes, [{ text: 'Saved graph.nous', error: false }]);
});

test('save: cancelled dialog toasts nothing; failure toasts the error', async () => {
  const cancelled = makeHarness({ saveFile: () => Promise.resolve(null) });
  cancelled.ctrl.toggleMenu();
  await cancelled.ctrl.save();
  assert.deepEqual(cancelled.flashes, []);

  const failed = makeHarness({ saveFile: () => Promise.reject(new Error('disk full')) });
  failed.ctrl.toggleMenu();
  await failed.ctrl.save();
  assert.deepEqual(failed.flashes, [{ text: 'disk full', error: true }]);
});

test('open: success, cancel, format error, and unknown error', async () => {
  const ok = makeHarness();
  ok.ctrl.toggleMenu();
  await ok.ctrl.open();
  assert.equal(ok.ctrl.state.menuOpen, false);
  assert.deepEqual(ok.flashes, [{ text: 'Opened graph.nous', error: false }]);

  const cancelled = makeHarness({ openFile: () => Promise.resolve(null) });
  await cancelled.ctrl.open();
  assert.deepEqual(cancelled.flashes, []);

  const malformed = makeHarness({
    openFile: () => Promise.reject(new NousFormatError('Not a NOUS file')),
  });
  await malformed.ctrl.open();
  assert.deepEqual(malformed.flashes, [{ text: 'Not a NOUS file', error: true }]);

  const unknown = makeHarness({ openFile: () => Promise.reject(new Error('EACCES')) });
  await unknown.ctrl.open();
  assert.deepEqual(unknown.flashes, [{ text: 'EACCES', error: true }]);
});

test('copy: success toasts and closes the menu', async () => {
  let written = '';
  const h = makeHarness({
    writeClipboard: (text) => {
      written = text;
      return Promise.resolve();
    },
  });
  h.ctrl.toggleMenu();
  await h.ctrl.copy();
  assert.equal(written, 'CODE123');
  assert.equal(h.ctrl.state.menuOpen, false);
  assert.deepEqual(h.flashes, [{ text: 'Share code copied to clipboard', error: false }]);
});

test('copy: clipboard blocked → code surfaces in the paste panel, menu stays open', async () => {
  const h = makeHarness({ writeClipboard: () => Promise.reject(new Error('denied')) });
  h.ctrl.toggleMenu();
  await h.ctrl.copy();
  assert.deepEqual(h.ctrl.state, { menuOpen: true, pasteOpen: true, pasteText: 'CODE123' });
  assert.deepEqual(h.flashes, [
    { text: 'Clipboard unavailable — copy the code below', error: true },
  ]);
});

test('paste panel: toggle preserves text; Cancel clears it but keeps the menu open', () => {
  const h = makeHarness();
  h.ctrl.toggleMenu();
  h.ctrl.togglePaste();
  h.ctrl.setPasteText('abc');
  h.ctrl.togglePaste(); // hide
  h.ctrl.togglePaste(); // show again
  assert.equal(h.ctrl.state.pasteText, 'abc');
  h.ctrl.cancelPaste();
  assert.deepEqual(h.ctrl.state, { menuOpen: true, pasteOpen: false, pasteText: '' });
});

test('submitPaste: success opens the graph, toasts, and closes everything', () => {
  let opened = '';
  const h = makeHarness({
    openShareCode: (code) => {
      opened = code;
    },
  });
  h.ctrl.toggleMenu();
  h.ctrl.togglePaste();
  h.ctrl.setPasteText('CODE123');
  h.ctrl.submitPaste();
  assert.equal(opened, 'CODE123');
  assert.deepEqual(h.ctrl.state, { menuOpen: false, pasteOpen: false, pasteText: '' });
  assert.deepEqual(h.flashes, [{ text: 'Graph opened in a new tab', error: false }]);
});

test('submitPaste: bad code toasts the error and keeps the panel open for a fix', () => {
  const h = makeHarness({
    openShareCode: () => {
      throw new NousFormatError('Unrecognized share code');
    },
  });
  h.ctrl.toggleMenu();
  h.ctrl.togglePaste();
  h.ctrl.setPasteText('garbage');
  h.ctrl.submitPaste();
  assert.deepEqual(h.ctrl.state, { menuOpen: true, pasteOpen: true, pasteText: 'garbage' });
  assert.deepEqual(h.flashes, [{ text: 'Unrecognized share code', error: true }]);
});

test('submitPaste: a non-Error throw is caught and toasted, never rethrown', () => {
  const h = makeHarness({
    openShareCode: () => {
      throw 'plain string failure'; // non-Error on purpose: untrusted-input path
    },
  });
  h.ctrl.togglePaste();
  h.ctrl.setPasteText('x');
  h.ctrl.submitPaste();
  assert.deepEqual(h.flashes, [{ text: 'plain string failure', error: true }]);
});

test('toasts fire independent of menu state (closed at flash time for actions)', async () => {
  const h = makeHarness();
  h.ctrl.toggleMenu();
  await h.ctrl.save(); // closes menu first, flash lands after
  h.ctrl.toggleMenu();
  await h.ctrl.copy(); // success also flashes around the close
  const blocked = makeHarness({ writeClipboard: () => Promise.reject(new Error('denied')) });
  blocked.ctrl.toggleMenu();
  await blocked.ctrl.copy(); // fallback flashes while menu stays OPEN
  assert.equal(h.openAtFlash[0], false); // save toast with menu closed
  assert.equal(blocked.openAtFlash[0], true); // fallback toast with menu open
  assert.equal(h.flashes.length, 2);
});

// M11 independence gate: the File menu and the CAS menu share no code path.
// A change to either file must have zero effect on the other, so neither
// side may reference the other's module or CSS vocabulary.
test('CAS menu (ExpressionRow) and File menu share no code path', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const expressionRow = read('../ExpressionRow.tsx');
  assert.ok(!/from '.*docMenu/.test(expressionRow), 'ExpressionRow must not import docMenu');
  assert.ok(!/from '.*DocActions/.test(expressionRow), 'ExpressionRow must not import DocActions');
  assert.ok(!expressionRow.includes('file-menu'), 'ExpressionRow must not use file-menu classes');
  const docActions = read('../DocActions.tsx') + read('../docMenu.ts');
  assert.ok(!/from '.*ExpressionRow/.test(docActions), 'File menu must not import ExpressionRow');
  assert.ok(!docActions.includes('cas-menu'), 'File menu must not use cas-menu classes');
  assert.ok(!docActions.includes('cas-button'), 'File menu must not use cas-button classes');
});
