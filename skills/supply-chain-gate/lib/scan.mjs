// scan.mjs — static heuristics for the `diff` command (SPEC §3). Pure, zero deps, Node 18+.
// Scans a JS/TS source string for the markers real droppers leave: obfuscation (long base64/hex
// blobs, eval, new Function, fromCharCode chains) and newly-introduced network / child_process use.
// These are HEURISTICS shown as evidence; the deterministic verdict still comes from detonation.

// Files worth scanning (skip binaries, maps, lockfiles).
const SCAN_EXT = /\.(js|cjs|mjs|jsx|ts|tsx)$/i;

export function isScannable(relPath) {
  const p = String(relPath);
  if (/(^|\/)node_modules\//.test(p)) return false;
  if (/\.min\.js$/i.test(p)) return false; // minified: naturally "long lines", too noisy
  return SCAN_EXT.test(p);
}

// Return an array of {line, kind, snippet} for one file's contents. `kind` ∈
// obfuscation | eval | new_function | char_codes | network | child_process | install_fetch
export function scanSource(relPath, contents) {
  const out = [];
  if (typeof contents !== 'string' || !contents) return out;
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const push = (kind) => out.push({ file: relPath, line: lineNo, kind, snippet: snippet(line) });

    // --- obfuscation: a long unbroken base64 or hex run (droppers hide their payload this way) ---
    if (/[A-Za-z0-9+/]{120,}={0,2}/.test(line)) push('obfuscation');
    else if (/(?:\\x[0-9a-fA-F]{2}|0x[0-9a-fA-F]{2},?){24,}/.test(line)) push('obfuscation');
    else if (/[0-9a-fA-F]{160,}/.test(line)) push('obfuscation');

    // --- dynamic code execution ---
    if (/\beval\s*\(/.test(line)) push('eval');
    if (/new\s+Function\s*\(/.test(line)) push('new_function');
    if (/\bfromCharCode\b/.test(line) && /fromCharCode[^)]*,[^)]*,[^)]*,/.test(line)) push('char_codes');

    // --- network ---
    if (/\bfetch\s*\(/.test(line)) push('network');
    else if (/require\(\s*['"](?:https?|net|dgram|tls|dns)['"]\s*\)/.test(line)) push('network');
    else if (/\bfrom\s+['"](?:node:)?(?:https?|net|dgram|tls|dns)['"]/.test(line)) push('network');
    else if (/\b(?:https?|net|dns)\.(?:request|get|connect|lookup|createConnection)\s*\(/.test(line)) push('network');

    // --- child process / shell ---
    if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(line)) push('child_process');
    else if (/\bfrom\s+['"](?:node:)?child_process['"]/.test(line)) push('child_process');
    else if (/\b(?:execSync|exec|spawn|spawnSync|execFile|execFileSync|fork)\s*\(/.test(line)) push('child_process');
  }
  return dedupePerLine(out);
}

// One finding per (line, coarse-category) so a busy line doesn't spam the list.
function dedupePerLine(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const cat = it.kind === 'eval' || it.kind === 'new_function' || it.kind === 'char_codes' ? 'obf' : it.kind;
    const key = `${it.line}|${cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function snippet(line) {
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

// Which of the scan kinds count as "obfuscation" for the rules layer / summary.
export const OBFUSCATION_KINDS = new Set(['obfuscation', 'eval', 'new_function', 'char_codes']);

// Extract the install-lifecycle scripts from a package.json string. Returns {} on parse failure.
export function installScripts(pkgJsonText) {
  try {
    const scripts = (JSON.parse(pkgJsonText) || {}).scripts || {};
    const out = {};
    for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      if (scripts[k]) out[k] = String(scripts[k]).slice(0, 200);
    }
    return out;
  } catch {
    return {};
  }
}
