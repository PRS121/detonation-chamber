// tiny-slugify — turn arbitrary text into a URL-safe slug. ESM, no build step.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} input
 * @param {{separator?: string, lower?: boolean, maxLength?: number, strict?: boolean}} [opts]
 * @returns {string}
 */
export function slugify(input, opts = {}) {
  const { separator = '-', lower = true, maxLength = 0, strict = false } = opts;
  if (input == null) return strict ? fail() : '';
  const sep = escapeRe(separator);

  let s = String(input)
    .replace(/[​-‍⁠﻿]/g, '') // strip zero-width characters
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-zA-Z0-9]+/g, separator) // non-alphanumerics -> separator
    .replace(new RegExp(`${sep}{2,}`, 'g'), separator) // collapse runs
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), ''); // trim ends

  if (lower) s = s.toLowerCase();
  if (maxLength > 0 && s.length > maxLength) {
    s = s.slice(0, maxLength).replace(new RegExp(`${sep}+$`), '');
  }
  if (strict && s === '') return fail();
  return s;
}

function fail() {
  throw new Error('slugify: input produced an empty slug');
}

export default slugify;
