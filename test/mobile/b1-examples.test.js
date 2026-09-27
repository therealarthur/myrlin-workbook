/**
 * b1-examples.test.js: every JSON example of PROTOCOL.md sections 2 to 11,
 * with placeholders replaced by concrete values (fixtures/examples/), validates
 * against the vendored schemas (BUILD-CONTRACT 3.5.1 item 14).
 *
 * WHY: the document, the schemas and the code must agree (DoD item 7). An
 * example the schema rejects is a bug in one of them, found before an agent
 * builds against the wrong one. fixtures/examples/index.json names each
 * file's schema, its PROTOCOL.md line and any hand substitution.
 */
'use strict';

const H = require('./_harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createChecker } = require('./_schema-check');

const DIR = path.join(__dirname, 'fixtures', 'examples');
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const schema = createChecker();
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/** Collect every string value of a JSON value. */
function strings(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

t('the index lists 64 examples, each file exists, and every file is listed', () => {
  assert.strictEqual(index.examples.length, 64);
  const listed = new Set(index.examples.map((e) => e.file));
  for (const e of index.examples) assert.ok(fs.existsSync(path.join(DIR, e.file)), e.file);
  for (const f of fs.readdirSync(DIR)) if (f !== 'index.json') assert.ok(listed.has(f), 'unlisted ' + f);
});

for (const e of index.examples) {
  t(e.file + (e.schema ? ' validates against ' + e.schema : ' parses (file format, no wire schema)'), () => {
    const value = JSON.parse(fs.readFileSync(path.join(DIR, e.file), 'utf8'));
    if (e.schema) schema.assertValid(e.schema, value);
    for (const s of strings(value, [])) {
      assert.ok(!/^<[^>]+>$/.test(s), 'placeholder left: ' + s);
      assert.ok(!/^(cl|cx|wb|pr|mg|u|d|c|p|e|t)_\.\.\.$/.test(s), 'truncated id left: ' + s);
    }
  });
}

t('the signed handshake examples carry 86 character signatures and vector keys', () => {
  const v = JSON.parse(fs.readFileSync(path.join(H.PROTOCOL_DIR, 'vectors', 'pairing.json'), 'utf8'));
  const idr = JSON.parse(fs.readFileSync(path.join(DIR, index.examples.find((e) => e.schema === 'handshake/identity-response.json').file), 'utf8'));
  assert.strictEqual(idr.computerPublicKey, v.keys.computer.spkiDerB64u);
  assert.strictEqual(idr.sig.length, 86);
});

H.run('b1-examples', tests);
