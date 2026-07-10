// Hostile-input probe for the .nous / share-code deserialization path.
//
// Feeds adversarial documents straight at the real deserializer and reports
// whether each is rejected with a structured NousFormatError (good) or crashes
// / hangs / is silently accepted (bad). This is what found the M10 F1 stack
// overflow (deeply nested folders → RangeError); it now doubles as a manual
// regression check that the M10.5 hardening still holds.
//
// Run from the repo root:  node scripts/fuzz-nous.mjs
// (Needs Node >= 22.18 — imports the .ts sources directly via type stripping.)

const S = await import('../src/state/serialize.ts');
const { parseNousJson, decodeShareCode, encodeShareCode } = S;

let bad = 0;
function run(name, expect, fn) {
  // expect: 'reject' (structured NousFormatError) or 'accept' (valid input).
  const t0 = performance.now();
  let outcome, detail;
  try {
    const r = fn();
    outcome = 'accepted';
    detail = typeof r === 'string' ? r : '';
  } catch (e) {
    outcome = e && e.constructor ? e.constructor.name : typeof e;
    detail = (e && e.message ? e.message : String(e)).slice(0, 70);
  }
  const ms = (performance.now() - t0).toFixed(1).padStart(6);
  const ok =
    expect === 'accept' ? outcome === 'accepted' : outcome === 'NousFormatError';
  if (!ok) bad++;
  const flag = ok ? '  ok ' : ' FAIL';
  console.log(`${flag} ${ms}ms  ${name}  ->  ${outcome}${detail ? `  "${detail}"` : ''}`);
}

const validItem = { kind: 'expression', source: 'y=x', colorIndex: 0, visible: true };
const wrap = (extra) =>
  JSON.stringify({ format: 'nous', version: 1, angleMode: 'radians', precision: 6, items: [validItem], ...extra });

console.log('--- malformed / adversarial .nous (expect structured rejection) ---');
run('garbage (not JSON)', 'reject', () => parseNousJson('{not json'));
run('empty object', 'reject', () => parseNousJson('{}'));
run('wrong format field', 'reject', () => parseNousJson(JSON.stringify({ format: 'evil', version: 1 })));
run('Infinity via 1e400 (precision)', 'reject', () =>
  parseNousJson(JSON.stringify({ format: 'nous', version: 1, angleMode: 'radians', precision: 1e400, items: [] })));
run('huge finite colorIndex 1e308', 'reject', () => parseNousJson(wrap({ items: [{ ...validItem, colorIndex: 1e308 }] })));
run('negative colorIndex', 'reject', () => parseNousJson(wrap({ items: [{ ...validItem, colorIndex: -1 }] })));
run('viewport magnitude 1e308', 'reject', () =>
  parseNousJson(wrap({ viewport: { xMin: -1e308, xMax: 1e308, yMin: -1, yMax: 1, width: 800, height: 600 } })));

// Deeply nested folders. Build the JSON textually — JSON.stringify is itself
// recursive and would overflow in THIS script before the deserializer ran.
function deepNest(depth) {
  const openF = '{"kind":"folder","name":"f","collapsed":false,"visible":true,"children":[';
  const leaf = '{"kind":"expression","source":"y=x","colorIndex":0,"visible":true}';
  return (
    '{"format":"nous","version":1,"angleMode":"radians","precision":6,"items":[' +
    openF.repeat(depth) + leaf + ']}'.repeat(depth) + ']}'
  );
}
run('nested folders depth 64 (at cap)', 'accept', () => { parseNousJson(deepNest(64)); return 'ok'; });
run('nested folders depth 65 (over cap)', 'reject', () => parseNousJson(deepNest(65)));
run('nested folders depth 50,000', 'reject', () => parseNousJson(deepNest(50_000)));

// Oversized source string — accepted (stored as data); should not hang.
run('10MB source string', 'accept', () =>
  { parseNousJson(wrap({ items: [{ ...validItem, source: 'y=' + 'x'.repeat(10_000_000) }] })); return 'stored'; });

// Prototype pollution — must be ignored (whitelisted fields), Object.prototype clean.
run('__proto__ JSON key (no pollution)', 'accept', () => {
  parseNousJson('{"format":"nous","version":1,"angleMode":"radians","precision":6,"items":[],"__proto__":{"polluted":"yes"}}');
  if (({}).polluted !== undefined) throw new Error('PROTOTYPE POLLUTED');
  return 'Object.prototype clean';
});

console.log('--- malformed share codes (expect structured rejection) ---');
run('non-base64 garbage', 'reject', () => decodeShareCode('!!!!not base64!!!!'));
run('truncated base64', 'reject', () => decodeShareCode('YWJ'));
run('valid base64, garbage bytes', 'reject', () => decodeShareCode('////////'));
run('empty string', 'reject', () => decodeShareCode(''));
run('deeply nested via share code', 'reject', () => decodeShareCode(Buffer.from(deepNest(50_000)).toString('base64')));
run('valid round-trip', 'accept', () => {
  const code = encodeShareCode({ items: [validItem], angleMode: 'radians', precision: 6 }, {});
  return `decoded ${decodeShareCode(code).doc.items.length} item(s)`;
});

console.log(bad === 0 ? '\nAll probes behaved as expected.' : `\n${bad} probe(s) FAILED — hardening regressed.`);
process.exit(bad === 0 ? 0 : 1);
