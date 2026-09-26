// integrity.mjs — sha256 snapshot of a directory tree + before/after diff (SPEC §6).
// Used to detect TAMPER: files created/changed/deleted outside a package's own subtree during install.
// Zero deps, Node 18+. Content hashes only (never file modes) so Linux and Windows agree.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Directories we never walk into: transient or expected-to-churn, not signal for tampering.
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm', '_cacache', '.npm-cache', '.cache']);

/**
 * Walk `root` and return a map of relative-posix-path -> sha256 hex of file contents.
 * Symlinks are recorded by their target string (not followed) so a planted symlink still shows up.
 * @param {string} root
 * @returns {Record<string,string>}
 */
export function snapshot(root) {
  const map = {};
  let base;
  try {
    base = fs.realpathSync(root);
  } catch {
    base = path.resolve(root);
  }
  walk(base, base, map);
  return map;
}

function walk(base, dir, map) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir: skip, don't throw
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(base, full, map);
      } else if (ent.isSymbolicLink()) {
        // record the link target itself; a malicious symlink is a change worth catching
        let target = '';
        try {
          target = fs.readlinkSync(full);
        } catch {
          target = '<unreadable-symlink>';
        }
        map[rel(base, full)] = hashString('symlink:' + target);
      } else if (ent.isFile()) {
        map[rel(base, full)] = hashFile(full);
      }
      // sockets/fifos/devices: ignore
    } catch {
      // per-entry failure shouldn't abort the whole walk
    }
  }
}

function rel(base, full) {
  return path.relative(base, full).split(path.sep).join('/');
}

function hashFile(file) {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '<unreadable>';
  }
}

function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Diff two snapshots.
 * @returns {{added:string[], modified:string[], deleted:string[]}} sorted arrays of relative paths
 */
export function diff(before, after) {
  const b = before || {};
  const a = after || {};
  const added = [];
  const modified = [];
  const deleted = [];
  for (const p of Object.keys(a)) {
    if (!(p in b)) added.push(p);
    else if (b[p] !== a[p]) modified.push(p);
  }
  for (const p of Object.keys(b)) {
    if (!(p in a)) deleted.push(p);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}
