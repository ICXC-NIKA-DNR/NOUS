// Undo/redo history (M7.2), including the milestone acceptance: a scripted
// sequence of ~20 mixed mutations round-trips exactly under full undo/redo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRedo,
  canUndo,
  dispatch,
  initHistory,
  redo,
  undo,
  type History,
} from '../history.ts';
import {
  emptyDocument,
  flattenExpressions,
  makeExpression,
  makeFolder,
  type Command,
  type GcalcDocument,
} from '../document.ts';

const start = (): GcalcDocument => emptyDocument([makeExpression('y = x')]);
const sources = (d: GcalcDocument): string[] => flattenExpressions(d).map((f) => f.item.source);

function run(h: History, cmds: Command[]): History {
  return cmds.reduce(dispatch, h);
}

test('a single undoable command creates one reversible step', () => {
  const doc = start();
  const id = flattenExpressions(doc)[0].item.id;
  let h = initHistory(doc);
  h = dispatch(h, { type: 'edit', id, source: 'y = 2x' });
  assert.equal(sources(h.present)[0], 'y = 2x');
  assert.ok(canUndo(h));
  h = undo(h);
  assert.equal(sources(h.present)[0], 'y = x');
  assert.ok(canRedo(h));
  h = redo(h);
  assert.equal(sources(h.present)[0], 'y = 2x');
});

test('consecutive edits to the SAME row coalesce into one undo step', () => {
  const doc = start();
  const id = flattenExpressions(doc)[0].item.id;
  let h = initHistory(doc);
  // Simulate a slider drag / typing burst: many edits to one row.
  for (const v of ['y = 1', 'y = 12', 'y = 123', 'y = 1234']) {
    h = dispatch(h, { type: 'edit', id, source: v });
  }
  assert.equal(sources(h.present)[0], 'y = 1234');
  assert.equal(h.past.length, 1); // one checkpoint for the whole burst
  h = undo(h);
  assert.equal(sources(h.present)[0], 'y = x'); // one undo reverts it all
});

test('edits to DIFFERENT rows are separate undo steps', () => {
  const a = makeExpression('a = 1');
  const b = makeExpression('b = 2');
  let h = initHistory(emptyDocument([a, b]));
  h = dispatch(h, { type: 'edit', id: a.id, source: 'a = 9' });
  h = dispatch(h, { type: 'edit', id: b.id, source: 'b = 8' });
  assert.equal(h.past.length, 2);
  h = undo(h);
  assert.deepEqual(sources(h.present), ['a = 9', 'b = 2']); // only b reverted
  h = undo(h);
  assert.deepEqual(sources(h.present), ['a = 1', 'b = 2']);
});

test('an edit after an undo starts a fresh step (no coalescing across undo)', () => {
  const doc = start();
  const id = flattenExpressions(doc)[0].item.id;
  let h = initHistory(doc);
  h = dispatch(h, { type: 'edit', id, source: 'y = 2x' });
  h = undo(h); // back to y = x
  h = dispatch(h, { type: 'edit', id, source: 'y = 3x' });
  assert.equal(sources(h.present)[0], 'y = 3x');
  h = undo(h);
  assert.equal(sources(h.present)[0], 'y = x'); // fresh step, not merged with the earlier one
});

test('non-undoable commands change the document without touching history', () => {
  let h = initHistory(start());
  h = dispatch(h, { type: 'setPrecision', precision: 10 });
  h = dispatch(h, { type: 'setAngleMode', angleMode: 'degrees' });
  assert.equal(h.present.precision, 10);
  assert.equal(h.present.angleMode, 'degrees');
  assert.equal(canUndo(h), false); // nothing to undo
});

test('a new command clears the redo stack', () => {
  const doc = start();
  const id = flattenExpressions(doc)[0].item.id;
  let h = initHistory(doc);
  h = dispatch(h, { type: 'edit', id, source: 'y = 2x' });
  h = undo(h);
  assert.ok(canRedo(h));
  h = dispatch(h, { type: 'add', item: makeExpression('z = 1') });
  assert.equal(canRedo(h), false); // redo invalidated by the new branch
});

test('undo/redo at the ends are safe no-ops', () => {
  const h = initHistory(start());
  assert.equal(undo(h), h);
  assert.equal(redo(h), h);
});

test('acceptance: ~20 mixed mutations round-trip under full undo then redo', () => {
  const e = makeExpression('y = x');
  const initial = emptyDocument([e]);
  let h = initHistory(initial);

  const a = makeExpression('a = 1');
  const b = makeExpression('b = 2');
  const folder = makeFolder('Trig');
  const inFolder = makeExpression('y = sin(x)');

  const script: Command[] = [
    { type: 'edit', id: e.id, source: 'y = x^2' },
    { type: 'add', item: a },
    { type: 'setSlider', id: a.id, slider: { min: 0, max: 10, step: 0.25 } },
    { type: 'edit', id: a.id, source: 'a = 3' }, // "drag" burst ↓ (coalesces)
    { type: 'edit', id: a.id, source: 'a = 3.5' },
    { type: 'edit', id: a.id, source: 'a = 4' },
    { type: 'add', item: b },
    { type: 'toggleVisible', id: b.id },
    { type: 'insertAfter', afterId: e.id, items: [makeExpression('y = -x')] },
    { type: 'addFolder', folder },
    { type: 'renameFolder', id: folder.id, name: 'Waves' },
    { type: 'insertAfter', afterId: folder.id, items: [inFolder] }, // sibling after folder
    { type: 'toggleFolderVisible', id: folder.id },
    { type: 'edit', id: b.id, source: 'b = 7' },
    { type: 'delete', id: a.id, fallback: makeExpression() },
    { type: 'toggleVisible', id: e.id },
    { type: 'edit', id: e.id, source: 'y = x^3' },
    { type: 'edit', id: inFolder.id, source: 'y = cos(x)' },
    { type: 'add', item: makeExpression('r = 2') },
    { type: 'toggleVisible', id: b.id },
  ];

  for (const cmd of script) h = dispatch(h, cmd);
  const finalSnapshot = JSON.stringify(h.present);
  const steps = h.past.length; // undoable steps recorded

  // Undo everything → exactly the initial document.
  while (canUndo(h)) h = undo(h);
  assert.equal(JSON.stringify(h.present), JSON.stringify(initial), 'full undo restores initial');

  // Redo everything → exactly the final document.
  for (let i = 0; i < steps; i++) h = redo(h);
  assert.equal(JSON.stringify(h.present), finalSnapshot, 'full redo restores final');
  assert.equal(canRedo(h), false);
});

test('history depth stays bounded', () => {
  const doc = start();
  let h = initHistory(doc);
  // 500 distinct-row-less edits would coalesce; alternate two rows so each is
  // its own step, exceeding the cap.
  const a = makeExpression('a = 0');
  const b = makeExpression('b = 0');
  h = dispatch(h, { type: 'add', item: a });
  h = dispatch(h, { type: 'add', item: b });
  for (let i = 0; i < 600; i++) {
    const id = i % 2 === 0 ? a.id : b.id;
    h = dispatch(h, { type: 'edit', id, source: `${i % 2 === 0 ? 'a' : 'b'} = ${i}` });
  }
  assert.ok(h.past.length <= 200, `past length ${h.past.length} should be capped`);
});

test('setSlider coalesces per row — a curve-node drag is one undo step (Slider-Anim-M2)', () => {
  const doc = start();
  const id = flattenExpressions(doc)[0].item.id;
  let h = initHistory(doc);
  // Simulate dragging a speed-curve node: many setSlider commands, one gesture.
  for (const mult of [1, 1.5, 2, 2.5, 3]) {
    h = dispatch(h, {
      type: 'setSlider',
      id,
      slider: { min: 0, max: 10, step: 1, curveNodes: [{ phase: 0, multiplier: mult }] },
    });
  }
  assert.equal(h.past.length, 1);
  h = undo(h);
  assert.equal(flattenExpressions(h.present)[0].item.slider, undefined);
});
