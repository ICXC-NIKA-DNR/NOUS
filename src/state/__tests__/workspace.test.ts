// Document tabs (M7): each tab is a fully independent editing session — its
// own document, its own undo/redo history, its own viewport. The PLAN.md
// acceptance is "two tabs hold independent state"; these tests pin that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTab,
  addTab,
  closeTab,
  dispatchInActive,
  initWorkspace,
  makeTab,
  redoInActive,
  replaceTabs,
  selectTab,
  setTabViewport,
  undoInActive,
  type Workspace,
} from '../workspace.ts';
import { emptyDocument, flattenExpressions, makeExpression } from '../document.ts';
import { canRedo, canUndo } from '../history.ts';
import type { Viewport } from '../../plot/viewport.ts';

const freshWs = (): Workspace =>
  initWorkspace(emptyDocument([makeExpression('y = x')]));

const activeSources = (ws: Workspace): string[] =>
  flattenExpressions(activeTab(ws).history.present).map((f) => f.item.source);

test('acceptance: two tabs hold independent documents and histories', () => {
  let ws = freshWs();
  const tab1 = activeTab(ws).id;
  const e1 = flattenExpressions(activeTab(ws).history.present)[0].item;

  // Edit tab 1.
  ws = dispatchInActive(ws, { type: 'edit', id: e1.id, source: 'y = x^2' });

  // Open tab 2 (independent doc) and edit it differently.
  const t2 = makeTab(emptyDocument([makeExpression('r = 2')]));
  ws = addTab(ws, t2);
  assert.equal(activeTab(ws).id, t2.id); // new tab becomes active
  assert.deepEqual(activeSources(ws), ['r = 2']);
  const e2 = flattenExpressions(activeTab(ws).history.present)[0].item;
  ws = dispatchInActive(ws, { type: 'edit', id: e2.id, source: 'r = 2 + 2cos(theta)' });

  // Tab 2's history has one step; tab 1's document is untouched by it.
  assert.ok(canUndo(activeTab(ws).history));
  ws = selectTab(ws, tab1);
  assert.deepEqual(activeSources(ws), ['y = x^2']);

  // Undo in tab 1 only affects tab 1.
  ws = undoInActive(ws);
  assert.deepEqual(activeSources(ws), ['y = x']);
  ws = selectTab(ws, t2.id);
  assert.deepEqual(activeSources(ws), ['r = 2 + 2cos(theta)']); // untouched
  assert.ok(canUndo(activeTab(ws).history)); // its own history intact

  // Redo in tab 1 only affects tab 1.
  ws = selectTab(ws, tab1);
  assert.ok(canRedo(activeTab(ws).history));
  ws = redoInActive(ws);
  assert.deepEqual(activeSources(ws), ['y = x^2']);
});

test('per-tab viewports are independent', () => {
  let ws = freshWs();
  const tab1 = activeTab(ws).id;
  const t2 = makeTab(emptyDocument([makeExpression()]));
  ws = addTab(ws, t2);

  const vp1: Viewport = { xMin: -1, xMax: 1, yMin: -1, yMax: 1, width: 800, height: 600 };
  const vp2: Viewport = { xMin: -99, xMax: 99, yMin: -50, yMax: 50, width: 800, height: 600 };
  ws = setTabViewport(ws, tab1, vp1);
  ws = setTabViewport(ws, t2.id, vp2);

  assert.equal(ws.tabs.find((t) => t.id === tab1)?.viewport, vp1);
  assert.equal(ws.tabs.find((t) => t.id === t2.id)?.viewport, vp2);
});

test('closing the active tab activates its right neighbour (or new last)', () => {
  let ws = freshWs();
  const t1 = activeTab(ws).id;
  const t2 = makeTab(emptyDocument([makeExpression()]));
  const t3 = makeTab(emptyDocument([makeExpression()]));
  ws = addTab(addTab(ws, t2), t3);

  // Close middle tab while it's inactive: active unchanged.
  ws = selectTab(ws, t1);
  ws = closeTab(ws, t2.id);
  assert.equal(ws.activeId, t1);
  assert.deepEqual(ws.tabs.map((t) => t.id), [t1, t3.id]);

  // Close the active first tab: right neighbour becomes active.
  ws = closeTab(ws, t1);
  assert.equal(ws.activeId, t3.id);

  // The last tab never closes.
  const same = closeTab(ws, t3.id);
  assert.equal(same, ws);
  assert.equal(same.tabs.length, 1);
});

test('closing the LAST-position active tab activates the new last tab', () => {
  let ws = freshWs();
  const t1 = activeTab(ws).id;
  const t2 = makeTab(emptyDocument([makeExpression()]));
  ws = addTab(ws, t2); // t2 active, at the end
  ws = closeTab(ws, t2.id);
  assert.equal(ws.activeId, t1);
});

test('selectTab ignores unknown ids; dispatch no-ops keep identity', () => {
  const ws = freshWs();
  assert.equal(selectTab(ws, 999999), ws);
  // A no-op command (setPrecision to its current value) must not churn state.
  assert.equal(dispatchInActive(ws, { type: 'setPrecision', precision: 6 }), ws);
});

test('replaceTabs swaps the whole workspace and activates the first (recovery)', () => {
  let ws = freshWs();
  // Grow the fresh session so we can prove it's discarded, not appended to.
  ws = addTab(ws, makeTab(emptyDocument([makeExpression('y = x + 1')])));
  assert.equal(ws.tabs.length, 2);

  const recovered = [
    makeTab(emptyDocument([makeExpression('r = 3')]), 'Polar'),
    makeTab(emptyDocument([makeExpression('y = x^3')]), 'Cubic'),
  ];
  ws = replaceTabs(ws, recovered);

  assert.deepEqual(ws.tabs.map((t) => t.id), recovered.map((t) => t.id)); // old tabs gone
  assert.deepEqual(ws.tabs.map((t) => t.name), ['Polar', 'Cubic']); // saved names kept
  assert.equal(ws.activeId, recovered[0].id); // first recovered tab active
});

test('replaceTabs with no tabs is a no-op (workspace keeps ≥1 tab)', () => {
  const ws = freshWs();
  assert.equal(replaceTabs(ws, []), ws);
});
