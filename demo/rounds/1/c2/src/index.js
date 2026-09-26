// tiny-slugify — turn arbitrary text into a URL-safe slug. ESM, no build step.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} input
 * @param {{separator?: string, lower?: boolean, maxLength?: number, maxWords?: number}} [opts]
 * @returns {string}
 */
export function slugify(input, opts = {}) {
  const { separator = '-', lower = true, maxLength = 0, maxWords = 0 } = opts;
  if (input == null) return '';
  const sep = escapeRe(separator);

  let s = String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase boundaries
    .replace(/[^a-zA-Z0-9]+/g, separator) // non-alphanumerics -> separator
    .replace(new RegExp(`${sep}{2,}`, 'g'), separator) // collapse runs
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), ''); // trim ends

  if (maxWords > 0) {
    s = s.split(separator).filter(Boolean).slice(0, maxWords).join(separator);
  }
  if (lower) s = s.toLowerCase();
  if (maxLength > 0 && s.length > maxLength) {
    s = s.slice(0, maxLength).replace(new RegExp(`${sep}+$`), '');
  }
  return s;
}

export default slugify;
