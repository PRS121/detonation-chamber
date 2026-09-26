import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('expands ampersands to "and"', () => {
  assert.equal(slugify('Salt & Pepper'), 'salt-and-pepper');
  assert.equal(slugify('R&D'), 'r-and-d');
});
