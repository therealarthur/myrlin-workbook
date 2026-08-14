#!/usr/bin/env node
/**
 * Tests for test/fixtures/codex-rollout-schema.json (Phase 17 Plan 17-01, CDX-09).
 *
 * Coverage:
 *   1. schema fixture exists and is valid JSON
 *   2. schema fixture enumerates all 5 known type variants
 *   3. parser code path handles every variant in the schema (drift gate)
 *
 * Test 3 is the load-bearing CI gate: if a future contributor adds a
 * `type` variant to the schema fixture without extending the parser's
 * KNOWN_ENVELOPE_TYPES list, this test fails. Likewise, if the parser
 * grows a new variant the schema doesn't know about, this test fails.
 *
 * Standalone-test convention: this file owns its own assertion helpers and
 * exits 0 on green / 1 on any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + err.message + '\x1b[0m');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
  }
}

const SCHEMA_PATH = path.join(__dirname, 'fixtures', 'codex-rollout-schema.json');

console.log('\n  Plan 17-01: codex-rollout-schema fixture (CI diff guard)');
console.log('  ' + '-'.repeat(70));

// ─── Test 1: file exists and parses ────────────────────────────────────────

let schema = null;
test('schema fixture exists and is valid JSON', () => {
  assert(fs.existsSync(SCHEMA_PATH), 'fixture missing at ' + SCHEMA_PATH);
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  schema = JSON.parse(raw);
  assert(schema && typeof schema === 'object', 'schema must be an object');
});

// ─── Test 2: enumerates the known type variants ───────────────────────────
//
// The list is written out here rather than read from the parser on purpose:
// this assertion is the independent second opinion that makes test 3 mean
// something. Extending it is a deliberate act, and the only reason to extend
// it is a measurement.
//
// 2026-05: five variants (Plan 17-01).
// 2026-08-13 (BUILD-CONTRACT P9.2): two more, measured by taking a payload-type
// histogram over the 60 largest rollouts on the reference machine. `world_state`
// appeared 5878 times and `inter_agent_communication_metadata` 368 times, and
// both were reaching the parser's silent default branch.

test('schema fixture enumerates all 7 known type variants', () => {
  assert(schema, 'schema must have parsed in test 1');
  assert(schema.properties, 'schema.properties missing');
  assert(schema.properties.type, 'schema.properties.type missing');
  const enumArr = schema.properties.type.enum;
  assert(Array.isArray(enumArr), 'schema.properties.type.enum must be an array');
  const expected = [
    'session_meta',
    'turn_context',
    'event_msg',
    'response_item',
    'compacted',
    'world_state',
    'inter_agent_communication_metadata',
  ];
  assertEqual(enumArr.length, expected.length, 'enum length mismatch');
  // Set equality, order-irrelevant.
  const enumSet = new Set(enumArr);
  for (const v of expected) {
    assert(enumSet.has(v), 'schema enum missing variant: ' + v);
  }
});

// ─── Test 3: parser KNOWN_ENVELOPE_TYPES matches schema enum (drift gate) ──

test('parser KNOWN_ENVELOPE_TYPES matches schema enum exactly', () => {
  const parse = require('../src/providers/codex/parse');
  assert(parse._internal, 'parse._internal must be exported for introspection');
  const known = parse._internal.KNOWN_ENVELOPE_TYPES;
  assert(Array.isArray(known), 'KNOWN_ENVELOPE_TYPES must be an array');
  const enumArr = schema.properties.type.enum;
  assertEqual(known.length, enumArr.length, 'parser known list length differs from schema enum');
  const knownSet = new Set(known);
  for (const v of enumArr) {
    assert(knownSet.has(v),
      'parser does not handle envelope type "' + v + '" but schema declares it. ' +
      'Drift gate: extend KNOWN_ENVELOPE_TYPES + add a switch case in parseTranscript, ' +
      'or remove the variant from the schema if it is no longer current.');
  }
  // Reverse direction: schema must enumerate every variant the parser recognizes.
  const enumSet = new Set(enumArr);
  for (const v of known) {
    assert(enumSet.has(v),
      'parser claims to handle "' + v + '" but schema does not declare it. ' +
      'Either add to schema enum (regenerate via scripts/regen-codex-schema.js if Codex CLI ' +
      'now supports the variant) or remove from KNOWN_ENVELOPE_TYPES.');
  }
});

console.log('  ' + '-'.repeat(70));
console.log('  Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
