// tiny-slugify — turn arbitrary text into a URL-safe slug. ESM, no build step.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} input
 * @param {{separator?: string, lower?: boolean, maxLength?: number, prefix?: string}} [opts]
 * @returns {string}
 */
export function slugify(input, opts = {}) {
  const { separator = '-', lower = true, maxLength = 0, prefix = '' } = opts;
  const sep = escapeRe(separator);

  let raw = input == null ? '' : String(input);
  if (prefix) raw = `${prefix} ${raw}`;
  if (raw === '') return '';

  let s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/&/g, ' and ') // expand ampersands
    .replace(/[^a-zA-Z0-9]+/g, separator) // non-alphanumerics -> separator
    .replace(new RegExp(`${sep}{2,}`, 'g'), separator) // collapse runs
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), ''); // trim ends

  if (lower) s = s.toLowerCase();
  if (maxLength > 0 && s.length > maxLength) {
    s = s.slice(0, maxLength).replace(new RegExp(`${sep}+$`), '');
  }
  return s;
}

export default slugify;
