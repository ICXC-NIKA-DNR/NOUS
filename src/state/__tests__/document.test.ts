// The command layer (M7.1): applyCommand is the single mutation choke point,
// so its correctness is the foundation undo/redo (M7.2) builds on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand,
  emptyDocument,
  findItem,
  flattenExpressions,
  isUndoable,
  locate,
  makeExpression,
  makeFolder,
  type GcalcDocument,
  type Item,
} from '../document.ts';

const doc = (items: Item[]): GcalcDocument => emptyDocument(items);
const exprIds = (d: GcalcDocument): number[] => flattenExpressions(d).map((e) => e.item.id);

test('edit updates source and clears the transient note', () => {
  const e = makeExpression('y = x');
  e.note = 'stale';
  const d = applyCommand(doc([e]), { type: 'edit', id: e.id, source: 'y = 2x' });
  const item = findItem(d.items, e.id);
  assert.equal(item?.kind === 'expression' && item.source, 'y = 2x');
  assert.equal(item?.kind === 'expression' && item.note, undefined);
});

test('setSlider, toggleVisible, setNote', () => {
  const e = makeExpression('a = 1');
  let d = doc([e]);
  d = applyCommand(d, { type: 'setSlider', id: e.id, slider: { min: -5, max: 5, step: 0.5 } });
  d = applyCommand(d, { type: 'toggleVisible', id: e.id });
  d = applyCommand(d, { type: 'setNote', id: e.id, note: 'hi' });
  const item = findItem(d.items, e.id);
  assert.ok(item?.kind === 'expression');
  if (item?.kind !== 'expression') return;
  assert.deepEqual(item.slider, { min: -5, max: 5, step: 0.5 });
  assert.equal(item.visible, false);
  assert.equal(item.note, 'hi');
});

test('add appends; insertAfter places directly after the target', () => {
  const a = makeExpression('a');
  const b = makeExpression('b');
  let d = doc([a]);
  d = applyCommand(d, { type: 'add', item: b });
  const c = makeExpression('c');
  d = applyCommand(d, { type: 'insertAfter', afterId: a.id, items: [c] });
  assert.deepEqual(exprIds(d), [a.id, c.id, b.id]);
});

test('delete removes; deleting the last item substitutes the fallback', () => {
  const a = makeExpression('a');
  const b = makeExpression('b');
  let d = doc([a, b]);
  d = applyCommand(d, { type: 'delete', id: a.id, fallback: makeExpression() });
  assert.deepEqual(exprIds(d), [b.id]);
  const fallback = makeExpression();
  d = applyCommand(d, { type: 'delete', id: b.id, fallback });
  assert.deepEqual(exprIds(d), [fallback.id]);
});

test('nesting: edits and inserts reach items inside folders', () => {
  const inner = makeExpression('y = x');
  const folder = makeFolder('F', [inner]);
  let d = doc([folder]);
  d = applyCommand(d, { type: 'edit', id: inner.id, source: 'y = x^2' });
  const found = findItem(d.items, inner.id);
  assert.equal(found?.kind === 'expression' && found.source, 'y = x^2');

  const added = makeExpression('y = x^3');
  d = applyCommand(d, { type: 'insertAfter', afterId: inner.id, items: [added] });
  const f = findItem(d.items, folder.id);
  assert.ok(f?.kind === 'folder' && f.children.length === 2);
  assert.equal(f?.kind === 'folder' && f.children[1].id, added.id);
});

test('move: expression into a folder, and back out to root', () => {
  const e = makeExpression('y = x');
  const folder = makeFolder('F');
  let d = doc([e, folder]);
  // Into folder (append: beforeId null).
  d = applyCommand(d, { type: 'move', id: e.id, targetFolderId: folder.id, beforeId: null });
  let f = findItem(d.items, folder.id);
  assert.ok(f?.kind === 'folder' && f.children.length === 1 && f.children[0].id === e.id);
  assert.equal(d.items.length, 1); // e no longer at root
  // Back out to root, before the folder.
  d = applyCommand(d, { type: 'move', id: e.id, targetFolderId: null, beforeId: folder.id });
  f = findItem(d.items, folder.id);
  assert.ok(f?.kind === 'folder' && f.children.length === 0);
  assert.deepEqual(exprIds(d), [e.id]);
  assert.equal(d.items[0].id, e.id); // e placed before the folder
});

test('move: reorder at root before a sibling (no index arithmetic)', () => {
  const a = makeExpression('a');
  const b = makeExpression('b');
  const c = makeExpression('c');
  let d = doc([a, b, c]);
  d = applyCommand(d, { type: 'move', id: c.id, targetFolderId: null, beforeId: a.id });
  assert.deepEqual(exprIds(d), [c.id, a.id, b.id]);
  // Move a to the end (beforeId null = append).
  d = applyCommand(d, { type: 'move', id: a.id, targetFolderId: null, beforeId: null });
  assert.deepEqual(exprIds(d), [c.id, b.id, a.id]);
});

test('move: a folder (with its children) into another folder', () => {
  const inner = makeExpression('y = x');
  const src = makeFolder('src', [inner]);
  const dst = makeFolder('dst');
  let d = doc([src, dst]);
  d = applyCommand(d, { type: 'move', id: src.id, targetFolderId: dst.id, beforeId: null });
  const dstFound = findItem(d.items, dst.id);
  assert.ok(dstFound?.kind === 'folder' && dstFound.children.length === 1);
  const moved = dstFound?.kind === 'folder' ? dstFound.children[0] : null;
  assert.ok(moved?.kind === 'folder' && moved.id === src.id && moved.children[0].id === inner.id);
  assert.equal(d.items.length, 1); // only dst remains at root
});

test('move: a folder into itself or its descendant is a no-op', () => {
  const grandchild = makeFolder('gc');
  const child = makeFolder('c', [grandchild]);
  const parent = makeFolder('p', [child]);
  const d = doc([parent, makeExpression('x')]);
  assert.equal(applyCommand(d, { type: 'move', id: parent.id, targetFolderId: parent.id, beforeId: null }), d);
  assert.equal(applyCommand(d, { type: 'move', id: parent.id, targetFolderId: grandchild.id, beforeId: null }), d);
});

test('move is undoable', () => {
  assert.equal(isUndoable({ type: 'move', id: 1, targetFolderId: null, beforeId: null }), true);
});

test('locate: parent and next sibling at root and inside folders', () => {
  const a = makeExpression('a');
  const inner1 = makeExpression('i1');
  const inner2 = makeExpression('i2');
  const folder = makeFolder('F', [inner1, inner2]);
  const b = makeExpression('b');
  const d = doc([a, folder, b]);

  assert.deepEqual(locate(d.items, a.id), { parentId: null, nextSiblingId: folder.id });
  assert.deepEqual(locate(d.items, b.id), { parentId: null, nextSiblingId: null }); // last at root
  assert.deepEqual(locate(d.items, inner1.id), { parentId: folder.id, nextSiblingId: inner2.id });
  assert.deepEqual(locate(d.items, inner2.id), { parentId: folder.id, nextSiblingId: null }); // last in folder
  assert.equal(locate(d.items, 99999), null);
});

test('folder commands: add, rename, collapse, visibility', () => {
  const folder = makeFolder('Untitled');
  let d = doc([folder]);
  d = applyCommand(d, { type: 'renameFolder', id: folder.id, name: 'Trig' });
  d = applyCommand(d, { type: 'toggleFolderCollapsed', id: folder.id });
  d = applyCommand(d, { type: 'toggleFolderVisible', id: folder.id });
  const f = findItem(d.items, folder.id);
  assert.ok(f?.kind === 'folder');
  if (f?.kind !== 'folder') return;
  assert.equal(f.name, 'Trig');
  assert.equal(f.collapsed, true);
  assert.equal(f.visible, false);
});

test('flattenExpressions cascades folder visibility to descendants', () => {
  const e1 = makeExpression('y = x'); // visible
  const e2 = makeExpression('y = 2x'); // own toggle off
  e2.visible = false;
  const nestedExpr = makeExpression('y = 3x');
  const nested = makeFolder('inner', [nestedExpr]);
  const outer = makeFolder('outer', [e1, e2, nested]);
  let d = doc([outer]);

  // All ancestors visible: e1 shown, e2 hidden by its own toggle, nested shown.
  let flat = flattenExpressions(d);
  const vis = (id: number): boolean => flat.find((f) => f.item.id === id)!.effectiveVisible;
  assert.equal(vis(e1.id), true);
  assert.equal(vis(e2.id), false);
  assert.equal(vis(nestedExpr.id), true);

  // Hide the outer folder → everything inside is effectively hidden.
  d = applyCommand(d, { type: 'toggleFolderVisible', id: outer.id });
  flat = flattenExpressions(d);
  const vis2 = (id: number): boolean => flat.find((f) => f.item.id === id)!.effectiveVisible;
  assert.equal(vis2(e1.id), false);
  assert.equal(vis2(nestedExpr.id), false);
  // Definitions remain listed (in scope) even when hidden.
  assert.equal(flat.length, 3);
});

test('settings commands are no-ops when unchanged (stable identity)', () => {
  const d0 = doc([makeExpression()]);
  assert.equal(applyCommand(d0, { type: 'setPrecision', precision: 6 }), d0); // already 6
  const d1 = applyCommand(d0, { type: 'setPrecision', precision: 10 });
  assert.equal(d1.precision, 10);
  const d2 = applyCommand(d0, { type: 'setAngleMode', angleMode: 'degrees' });
  assert.equal(d2.angleMode, 'degrees');
});

test('isUndoable excludes settings, notes, and folder collapse', () => {
  assert.equal(isUndoable({ type: 'edit', id: 1, source: 'x' }), true);
  assert.equal(isUndoable({ type: 'toggleVisible', id: 1 }), true);
  assert.equal(isUndoable({ type: 'toggleFolderVisible', id: 1 }), true);
  assert.equal(isUndoable({ type: 'delete', id: 1, fallback: makeExpression() }), true);
  assert.equal(isUndoable({ type: 'setNote', id: 1, note: 'x' }), false);
  assert.equal(isUndoable({ type: 'toggleFolderCollapsed', id: 1 }), false);
  assert.equal(isUndoable({ type: 'setAngleMode', angleMode: 'degrees' }), false);
  assert.equal(isUndoable({ type: 'setPrecision', precision: 8 }), false);
});

test('immutability: applyCommand never mutates the input document', () => {
  const e = makeExpression('y = x');
  const before = doc([e]);
  const snapshot = JSON.stringify(before);
  applyCommand(before, { type: 'edit', id: e.id, source: 'changed' });
  applyCommand(before, { type: 'toggleVisible', id: e.id });
  assert.equal(JSON.stringify(before), snapshot);
});
