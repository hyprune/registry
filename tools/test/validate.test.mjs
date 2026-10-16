import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateEntry } from '../lib/validate.mjs';

const dir = new URL('../../entries/official/', import.meta.url);
const entry = JSON.parse(readFileSync(new URL(readdirSync(dir).find(n => n.endsWith('.json')), dir), 'utf8'));

test('extension is a reserved type: schema-valid, refused by the registry', () => {
  assert.deepEqual(validateEntry(entry), []);
  assert.deepEqual(validateEntry({ ...entry, type: 'extension' }), ['type extension is reserved: the registry lists worlds and libraries until an extension host exists']);
  assert.notDeepEqual(validateEntry({ ...entry, type: 'plugin' }), []);
});
