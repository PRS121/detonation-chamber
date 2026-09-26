import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('maxWords keeps only the first N words', () => {
  assert.equal(slugify('one two three four', { maxWords: 2 }), 'one-two');
  assert.equal(slugify('Release Captain Ships It', { maxWords: 3 }), 'release-captain-ships');
});

test('maxWords of 0 keeps everything', () => {
  assert.equal(slugify('one two three', { maxWords: 0 }), 'one-two-three');
});
