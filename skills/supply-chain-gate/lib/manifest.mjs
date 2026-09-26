// manifest.mjs — content manifest of a package's packed files (SPEC §3).
// "The bytes we tested are the bytes we ship": the sandbox computes this after a clean detonation,
// and the host (mcp/release-ops/src/publish.ts) computes it again just before publishing. If the two
// hashes differ, the tarball changed between test and publish and the publish is refused.
//
// Zero deps, Node 18+. Imported unchanged by both the sandbox and the Windows host, so it must be
// deterministic across platforms: hash raw file BYTES only (never modes), use forward-slash paths,
// and sort by plain UTF-16 code-unit order (String.prototype.sort), never localeCompare.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// A packed path as npm reports it, normalised to forward slashes for a cross-platform-stable line.
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * @param {string} dir    directory the package was packed from (npm pack was run here)
 * @param {string[]} files  the `path` values from `npm pack --dry-run --json --ignore-scripts`
 * @returns {{manifest_sha256: string, files: string[], entries: {path: string, sha256: string}[]}}
 */
export function computeManifest(dir, files) {
  const sorted = [...new Set((files || []).map(toPosix))].sort();
  const entries = [];
  const lines = [];
  for (const rel of sorted) {
    // Read the file's exact bytes from disk. Missing/unreadable -> a stable marker, never a throw,
    // so a manifest can still be produced and a mismatch will surface it.
    let hash;
    try {
      hash = sha256Hex(fs.readFileSync(path.join(dir, rel)));
    } catch {
      hash = '0'.repeat(64);
    }
    entries.push({ path: rel, sha256: hash });
    lines.push(`${hash}  ${rel}`); // two spaces, sha256sum style
  }
  const manifest_sha256 = sha256Hex(lines.join('\n'));
  return { manifest_sha256, files: sorted, entries };
}
