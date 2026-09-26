import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('prefix is prepended and slugified together', () => {
  assert.equal(slugify('World', { prefix: 'Hello' }), 'hello-world');
  assert.equal(slugify('Notes', { prefix: 'v2' }), 'v2-notes');
});

test('ampersand fix from the previous commit still applies', () => {
  assert.equal(slugify('Salt & Pepper'), 'salt-and-pepper');
});
