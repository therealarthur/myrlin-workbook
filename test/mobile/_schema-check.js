/**
 * _schema-check.js: a small JSON Schema validator for exactly the keyword
 * subset protocol/README.md lists, used by every mobile v2 test.
 *
 * WHY: BUILD-CONTRACT 3.5.1 item 14 and rule 9: no new dependencies, so the
 * tests validate responses, events and examples against the vendored
 * protocol/schemas with an in repo validator. Keywords: $schema, $id, $ref,
 * $defs, title, description, type (and type arrays), properties, required,
 * additionalProperties, enum, const, pattern, minLength, maxLength, minimum,
 * maximum, items, prefixItems, minItems, maxItems, uniqueItems,
 * minProperties, oneOf, anyOf, allOf, if, then. Anything else is an error, so
 * a schema that grows a keyword cannot silently pass.
 *
 * Usage:
 *   const { createChecker } = require('./_schema-check');
 *   const check = createChecker();                  // loads fixtures/protocol/schemas
 *   const errs = check.validate('handshake/hello-response.json', body);
 *   check.assertValid('resources/device.json', body); // throws with the errors
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Keywords this validator implements. */
const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'oneOf', 'anyOf',
  'allOf', 'if', 'then',
]);

/** Default schema root: the vendored protocol copy. */
const DEFAULT_ROOT = path.join(__dirname, 'fixtures', 'protocol', 'schemas');

/**
 * Deep equality for const, enum and uniqueItems.
 *
 * @param {*} a - First.
 * @param {*} b - Second.
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * The JSON type name of a value.
 *
 * @param {*} v - Value.
 * @returns {string}
 */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/**
 * Create a checker over a schema folder.
 *
 * @param {string} [root] - Folder holding the schemas.
 * @returns {{validate: Function, assertValid: Function, schemas: Map}}
 */
function createChecker(root) {
  const base = root || DEFAULT_ROOT;
  /** absolute file path -> schema */
  const schemas = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) schemas.set(path.resolve(full), JSON.parse(fs.readFileSync(full, 'utf8')));
    }
  })(base);

  /**
   * Resolve a $ref relative to the file that holds it.
   *
   * @param {string} ref - The $ref value.
   * @param {string} file - Absolute path of the referring schema's file.
   * @returns {{schema: object, file: string}}
   */
  function resolveRef(ref, file) {
    const [filePart, frag] = ref.split('#');
    const target = filePart ? path.resolve(path.dirname(file), filePart) : file;
    let node = schemas.get(target);
    if (!node) throw new Error('unresolved $ref ' + ref + ' from ' + file);
    if (frag) {
      for (const seg of frag.split('/').filter(Boolean)) {
        node = node[decodeURIComponent(seg)];
        if (node === undefined) throw new Error('unresolved $ref fragment ' + ref);
      }
    }
    return { schema: node, file: target };
  }

  /**
   * Validate a value against a schema node.
   *
   * @param {object|boolean} schema - Schema node.
   * @param {*} value - Value.
   * @param {string} file - File that holds the node.
   * @param {string} at - JSON pointer of the value, for messages.
   * @param {string[]} errs - Accumulator.
   */
  function check(schema, value, file, at, errs) {
    if (schema === true) return;
    if (schema === false) { errs.push(at + ': no value allowed'); return; }
    for (const k of Object.keys(schema)) {
      if (!KNOWN.has(k)) errs.push(at + ': unsupported keyword ' + k + ' in ' + path.basename(file));
    }
    if (schema.$ref) {
      const r = resolveRef(schema.$ref, file);
      check(r.schema, value, r.file, at, errs);
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const t = typeOf(value);
      const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
      if (!ok) { errs.push(at + ': expected ' + types.join('|') + ', got ' + t); return; }
    }
    if (schema.const !== undefined && !deepEqual(schema.const, value)) errs.push(at + ': expected const ' + JSON.stringify(schema.const));
    if (schema.enum && !schema.enum.some((v) => deepEqual(v, value))) errs.push(at + ': ' + JSON.stringify(value) + ' not in enum');
    if (typeof value === 'string') {
      const len = Array.from(value).length;
      if (schema.minLength !== undefined && len < schema.minLength) errs.push(at + ': shorter than ' + schema.minLength);
      if (schema.maxLength !== undefined && len > schema.maxLength) errs.push(at + ': longer than ' + schema.maxLength);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errs.push(at + ': does not match ' + schema.pattern);
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(at + ': below ' + schema.minimum);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(at + ': above ' + schema.maximum);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(at + ': fewer than ' + schema.minItems + ' items');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(at + ': more than ' + schema.maxItems + ' items');
      if (schema.uniqueItems) {
        for (let i = 0; i < value.length; i += 1) {
          for (let j = i + 1; j < value.length; j += 1) if (deepEqual(value[i], value[j])) errs.push(at + ': duplicate items ' + i + ' and ' + j);
        }
      }
      const prefix = schema.prefixItems || [];
      prefix.forEach((s, i) => { if (i < value.length) check(s, value[i], file, at + '/' + i, errs); });
      if (schema.items !== undefined) {
        for (let i = prefix.length; i < value.length; i += 1) check(schema.items, value[i], file, at + '/' + i, errs);
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const props = schema.properties || {};
      for (const r of schema.required || []) if (!(r in value)) errs.push(at + ': missing ' + r);
      if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) errs.push(at + ': fewer than ' + schema.minProperties + ' properties');
      for (const [k, v] of Object.entries(value)) {
        if (props[k] !== undefined) check(props[k], v, file, at + '/' + k, errs);
        else if (schema.additionalProperties === false) errs.push(at + ': unexpected property ' + k);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, v, file, at + '/' + k, errs);
      }
    }
    if (schema.allOf) for (const s of schema.allOf) check(s, value, file, at, errs);
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s) => { const e = []; check(s, value, file, at, e); return e.length === 0; });
      if (!ok) errs.push(at + ': matches none of anyOf');
    }
    if (schema.oneOf) {
      const n = schema.oneOf.filter((s) => { const e = []; check(s, value, file, at, e); return e.length === 0; }).length;
      if (n !== 1) errs.push(at + ': matches ' + n + ' of oneOf (exactly one required)');
    }
    if (schema.if !== undefined) {
      const e = [];
      check(schema.if, value, file, at, e);
      if (e.length === 0 && schema.then !== undefined) check(schema.then, value, file, at, errs);
    }
  }

  /**
   * Validate a value against a schema file.
   *
   * @param {string} rel - Path relative to the schema root, e.g. "resources/device.json".
   * @param {*} value - Value.
   * @returns {string[]} Errors, empty when valid.
   */
  function validate(rel, value) {
    const file = path.resolve(base, rel);
    const schema = schemas.get(file);
    if (!schema) return ['no schema ' + rel];
    const errs = [];
    check(schema, value, file, '', errs);
    return errs;
  }

  /**
   * Throw when a value does not validate.
   *
   * @param {string} rel - Schema path.
   * @param {*} value - Value.
   */
  function assertValid(rel, value) {
    const errs = validate(rel, value);
    if (errs.length) throw new Error(rel + ' validation failed: ' + errs.slice(0, 6).join('; '));
  }

  return { validate, assertValid, schemas, root: base };
}

module.exports = { createChecker, deepEqual, KNOWN };
