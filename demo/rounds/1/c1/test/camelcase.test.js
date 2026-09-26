import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('splits camelCase boundaries', () => {
  assert.equal(slugify('fooBar'), 'foo-bar');
  assert.equal(slugify('ReleaseCaptainV2'), 'release-captain-v2');
});
