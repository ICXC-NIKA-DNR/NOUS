import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportBaseName } from '../exportName.ts';

test('plain names pass through, trimmed; spaces and hyphens kept', () => {
  assert.equal(exportBaseName('Graph 1'), 'Graph 1');
  assert.equal(exportBaseName('  Projectile  '), 'Projectile');
  assert.equal(exportBaseName('my-graph'), 'my-graph');
});

test('illegal filename characters are stripped', () => {
  assert.equal(exportBaseName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
});

test('empty / all-illegal / dots-only fall back to graph', () => {
  assert.equal(exportBaseName(''), 'graph');
  assert.equal(exportBaseName('   '), 'graph');
  assert.equal(exportBaseName('///'), 'graph');
  assert.equal(exportBaseName('...'), 'graph');
});

test('leading/trailing dots dropped; inner whitespace collapses', () => {
  assert.equal(exportBaseName('.hidden'), 'hidden');
  assert.equal(exportBaseName('name.'), 'name');
  assert.equal(exportBaseName('a\t\n  b'), 'a b');
});

test('length is capped at 100', () => {
  assert.equal(exportBaseName('x'.repeat(200)).length, 100);
});
