// Autosave session envelope (M8.3): multi-tab round-trip and rejection of
// half-written payloads (a crash can land mid-write; recovery must offer
// nothing rather than restore garbage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument, makeExpression, makeFolder } from '../document.ts';
import { packSession, unpackSession } from '../autosave.ts';
import { NousFormatError } from '../serialize.ts';

const tabA = {
  name: 'Graph 1',
  doc: emptyDocument([makeExpression('y = sin x'), makeFolder('f', [makeExpression('a = 1')])]),
  viewport: { xMin: -10, xMax: 10, yMin: -5, yMax: 5, width: 640, height: 480 },
};
const tabB = { name: 'Scratch', doc: emptyDocument([makeExpression('y = x^2')]), viewport: null };

test('session round-trips every tab with names and viewports', () => {
  const payload = packSession([tabA, tabB], 1234567890);
  const session = unpackSession(payload);
  assert.equal(session.savedAt, 1234567890);
  assert.equal(session.tabs.length, 2);
  assert.equal(session.tabs[0].name, 'Graph 1');
  assert.deepEqual(session.tabs[0].viewport, tabA.viewport);
  assert.equal(session.tabs[1].name, 'Scratch');
  assert.equal(session.tabs[1].viewport, undefined);
  const first = session.tabs[0].doc.items;
  assert.equal(first[0].kind === 'expression' && first[0].source, 'y = sin x');
  assert.equal(first[1].kind, 'folder');
});

test('rejects truncated payloads (crash mid-write)', () => {
  const payload = packSession([tabA]);
  assert.throws(() => unpackSession(payload.slice(0, payload.length / 2)), NousFormatError);
});

test('rejects foreign or empty payloads', () => {
  assert.throws(() => unpackSession('{}'), NousFormatError);
  assert.throws(() => unpackSession('null'), NousFormatError);
  assert.throws(
    () => unpackSession(JSON.stringify({ format: 'nous-session', version: 1, savedAt: 1, tabs: [] })),
    NousFormatError,
  );
  assert.throws(
    () =>
      unpackSession(
        JSON.stringify({ format: 'nous-session', version: 1, savedAt: 1, tabs: [{ bogus: true }] }),
      ),
    NousFormatError,
  );
});
