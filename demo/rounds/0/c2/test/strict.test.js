import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('strict throws when the slug would be empty', () => {
  assert.throws(() => slugify('!!!', { strict: true }), /empty slug/);
  assert.throws(() => slugify('', { strict: true }), /empty slug/);
});

test('strict returns a normal slug when non-empty', () => {
  assert.equal(slugify('Hello World', { strict: true }), 'hello-world');
});
