// .nous serialization (M8.1). The milestone accept: a complex document
// round-trips equivalently (modulo reminted ids), share codes round-trip the
// same way, and malformed/truncated input produces a structured error rather
// than a crash or partial state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewport } from '../../plot/viewport.ts';
import {
  emptyDocument,
  makeExpression,
  makeFolder,
  type GcalcDocument,
  type Item,
} from '../document.ts';
import {
  decodeShareCode,
  documentToJson,
  encodeShareCode,
  NousFormatError,
  parseNousJson,
  serializeDocument,
} from '../serialize.ts';

/** A document exercising every serialized feature: nested folders, sliders,
 * hidden items, collapsed folders, restricted domains, unicode sources. */
function complexDocument(): GcalcDocument {
  const slider = makeExpression('a = 2', { min: -5, max: 5, step: 0.1 });
  const hidden = makeExpression('y = a x^2');
  hidden.visible = false;
  const inner = makeFolder('inner', [makeExpression('y = sin x {x > 0}'), hidden]);
  inner.collapsed = true;
  const outer = makeFolder('trig — π stuff', [makeExpression('y = cos x'), inner]);
  outer.visible = false;
  // A user-defined function definition (M9.5) — just source text, round-trips
  // like any other row.
  const doc = emptyDocument([
    slider,
    makeExpression('myfn(x) = a x^2'),
    outer,
    makeExpression('(a, a^2)'),
  ]);
  return { ...doc, angleMode: 'degrees', precision: 8 };
}

const viewport: Viewport = { xMin: -3, xMax: 7, yMin: -1.5, yMax: 4, width: 800, height: 600 };

/** Structural equality ignoring session-local ids (reminted on load) and
 * explicit-undefined vs absent optional keys. */
function stripIds(items: Item[]): unknown[] {
  return items.map((it) =>
    it.kind === 'folder'
      ? { ...it, id: 0, children: stripIds(it.children) }
      : { ...it, id: 0, slider: it.slider ?? null, note: it.note ?? null },
  );
}

function assertSameDocument(a: GcalcDocument, b: GcalcDocument): void {
  assert.deepEqual(stripIds(a.items), stripIds(b.items));
  assert.equal(a.angleMode, b.angleMode);
  assert.equal(a.precision, b.precision);
}

function collectIds(items: Item[], into: number[] = []): number[] {
  for (const it of items) {
    into.push(it.id);
    if (it.kind === 'folder') collectIds(it.children, into);
  }
  return into;
}

test('file JSON round-trips a complex document (modulo ids)', () => {
  const doc = complexDocument();
  const json = documentToJson(doc, { name: 'My graph', viewport });
  const loaded = parseNousJson(json);
  assertSameDocument(loaded.doc, doc);
  assert.equal(loaded.name, 'My graph');
  assert.deepEqual(loaded.viewport, viewport);
});

test('serialization is stable: save → load → save yields identical bytes', () => {
  const doc = complexDocument();
  const first = documentToJson(doc, { name: 'g', viewport });
  const second = documentToJson(parseNousJson(first).doc, { name: 'g', viewport });
  assert.equal(first, second);
});

test('share code round-trips the same document', () => {
  const doc = complexDocument();
  const code = encodeShareCode(doc, { viewport });
  const loaded = decodeShareCode(code);
  assertSameDocument(loaded.doc, doc);
  assert.deepEqual(loaded.viewport, viewport);
});

test('share code survives surrounding whitespace/newlines from paste', () => {
  const doc = complexDocument();
  const code = encodeShareCode(doc);
  const pasted = `  ${code.slice(0, 10)}\n${code.slice(10)} \n`;
  assertSameDocument(decodeShareCode(pasted).doc, doc);
});

test('loading remints ids — no collisions with pre-existing items', () => {
  const doc = complexDocument();
  const existing = new Set(collectIds(doc.items));
  const loaded = parseNousJson(documentToJson(doc));
  for (const id of collectIds(loaded.doc.items)) {
    assert.ok(!existing.has(id), `id ${id} collided with a live item`);
  }
});

test('ids and transient notes are not serialized', () => {
  const e = makeExpression('y = x');
  e.note = 'transient CAS note';
  const file = serializeDocument(emptyDocument([e]));
  const item = file.items[0];
  assert.ok(!('id' in item));
  assert.ok(!('note' in item));
});

test('viewport and name are optional', () => {
  const loaded = parseNousJson(documentToJson(complexDocument()));
  assert.equal(loaded.name, undefined);
  assert.equal(loaded.viewport, undefined);
});

/* ---- malformed input: structured errors, never crashes ---- */

const good = (): Record<string, unknown> =>
  JSON.parse(documentToJson(complexDocument(), { viewport })) as Record<string, unknown>;

function assertRejects(value: unknown, pathFragment?: string): void {
  assert.throws(
    () => parseNousJson(JSON.stringify(value)),
    (err: unknown) => {
      assert.ok(err instanceof NousFormatError, `expected NousFormatError, got ${err}`);
      if (pathFragment) assert.match(err.message, new RegExp(pathFragment.replace(/[[\]().]/g, '\\$&')));
      return true;
    },
  );
}

test('rejects non-JSON and non-object payloads', () => {
  assert.throws(() => parseNousJson('not json {'), NousFormatError);
  assertRejects(42);
  assertRejects(null);
  assertRejects([1, 2, 3]);
});

test('rejects wrong format tag and unsupported versions', () => {
  assertRejects({ ...good(), format: 'desmos' }, 'format');
  assertRejects({ ...good(), version: 2 }, 'version');
  assertRejects({ ...good(), version: '1' }, 'version');
});

test('rejects invalid document settings', () => {
  assertRejects({ ...good(), angleMode: 'gradians' }, 'angleMode');
  assertRejects({ ...good(), precision: 0 }, 'precision');
  assertRejects({ ...good(), precision: 6.5 }, 'precision');
});

test('rejects malformed items with a path to the offending field', () => {
  assertRejects({ ...good(), items: 'nope' }, 'items');
  assertRejects({ ...good(), items: [{ kind: 'mystery' }] }, 'items[0].kind');
  assertRejects(
    { ...good(), items: [{ kind: 'expression', source: 5, colorIndex: 0, visible: true }] },
    'items[0].source',
  );
  assertRejects(
    {
      ...good(),
      items: [
        {
          kind: 'folder',
          name: 'f',
          collapsed: false,
          visible: true,
          children: [{ kind: 'expression', source: 'y=x', colorIndex: 0, visible: 'yes' }],
        },
      ],
    },
    'items[0].children[0].visible',
  );
});

test('rejects malformed sliders and viewports', () => {
  assertRejects(
    {
      ...good(),
      items: [
        { kind: 'expression', source: 'a=1', colorIndex: 0, visible: true, slider: { min: 0, max: 'x', step: 1 } },
      ],
    },
    'items[0].slider.max',
  );
  assertRejects({ ...good(), viewport: { ...viewport, xMax: -10 } }, 'viewport');
  assertRejects({ ...good(), viewport: { ...viewport, yMin: Infinity } });
});

test('rejects truncated and corrupted share codes without side effects', () => {
  const code = encodeShareCode(complexDocument());
  assert.throws(() => decodeShareCode(code.slice(0, code.length - 3)), NousFormatError);
  assert.throws(() => decodeShareCode('$$$not base64$$$'), NousFormatError);
  assert.throws(() => decodeShareCode(''), NousFormatError);
  // Valid base64 of garbage bytes → still a structured error.
  assert.throws(() => decodeShareCode('AAECAwQ='), NousFormatError);
});
