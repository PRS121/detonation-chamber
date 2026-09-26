import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('strips zero-width characters', () => {
  assert.equal(slugify('Hello​World'), 'helloworld');
  assert.equal(slugify('Foo﻿ Bar'), 'foo-bar');
});
