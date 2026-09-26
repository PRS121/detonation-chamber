// rules.mjs — deterministic verdict engine (SPEC §5). Pure functions, zero deps, Node 18+.
// Turns the tripwire event log + integrity diff (+ optional static-diff and npm-intel inputs)
// into findings and a SAFE / BLOCKED / INCONCLUSIVE verdict. The LLM never decides the verdict;
// it may only escalate SAFE -> INCONCLUSIVE downstream (model policy in §5).

const SEV_ORDER = { critical: 3, high: 2, info: 1 };

// Event types the tripwire emits that represent an OUTBOUND action (where a decoy value in the
// payload/argv proves exfiltration, and a "(blocked)" marker proves a disallowed connection).
const OUTBOUND_TYPES = new Set([
  'net_connect',
  'dns_lookup',
  'http_request',
  'fetch',
  'exfil_body',
  'child_process',
  'shim_invoked',
]);

function isNpmActor(ev) {
  return ev && ev.actor && ev.actor.pkg === 'npm';
}

const INSTALL_LIFECYCLES = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']);

// HONEYTOKEN_READ means *untrusted package code* read a decoy. A read counts as untrusted when it
// comes from a real node_modules frame, OR during an install-time lifecycle script (postinstall &c).
// It does NOT count for the npm CLI (legitimate ~/.npmrc), for the project's own code, or for reads
// with no package frame during `test` / other non-install phases — those are the project and Node's
// own runtime (test runner, module loader) legitimately touching the environment they run in.
function isUntrustedReader(ev) {
  if (!ev || !ev.actor) return false;
  if (ev.actor.pkg === 'npm') return false;
  if (ev.actor.pkg === 'project') return false;
  const frame = ev.actor.frame || '';
  if (frame.includes('/node_modules/')) return true; // a dependency's own code on the stack
  if (ev.actor.lifecycle && INSTALL_LIFECYCLES.has(ev.actor.lifecycle)) return true; // dep install hook
  return false;
}

// A finding key = rule + actor string, so we de-duplicate repeated hits from the same actor.
function actorStr(ev) {
  if (!ev || !ev.actor) return 'unknown';
  const pkg = ev.actor.pkg || 'unknown';
  return ev.actor.lifecycle ? `${pkg} (${ev.actor.lifecycle})` : pkg;
}

/**
 * @param {object} input
 * @param {Array} input.events      parsed tripwire events (one per JSONL line)
 * @param {boolean} input.logOk     false if the log was missing/unparseable
 * @param {object} input.integrity  {added:[], modified:[], deleted:[]} from lib/integrity.mjs (project/ only)
 * @param {string} input.pkg        the package under test (its own node_modules subtree is exempt from TAMPER)
 * @param {object} [input.diff]     static diff result {install_scripts:{before,after}, suspicious:[...]}
 * @param {object} [input.intel]    npm intel {age_hours, has_provenance, maintainers_changed, removed_versions_in_range}
 * @param {object} [input.timings]  {install_ms, test_ms}
 * @returns {{verdict, severity, summary, findings, network, tampered}}
 */
export function evaluate(input) {
  const events = Array.isArray(input.events) ? input.events : [];
  const findings = new Map(); // key -> finding (dedup)
  const network = new Map(); // host -> {host, allowed, actor}

  const add = (rule, severity, actor, detail) => {
    const key = `${rule}|${actor}|${detail || ''}`;
    if (!findings.has(key)) findings.set(key, { rule, severity, actor, detail });
  };

  // ---- LOG_MISSING (high): can't trust anything if the log is gone ----------
  if (input.logOk === false) {
    add('LOG_MISSING', 'high', 'tripwire', 'event log missing or unparseable');
  }

  // ---- Walk the event log ---------------------------------------------------
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const actor = actorStr(ev);
    const type = ev.type;

    // HONEYTOKEN_READ: decoy env read or decoy-file read under room HOME, by untrusted package code
    // (a dependency / install hook) — not the npm CLI, the project itself, or Node's own runtime.
    if (type === 'env_read' && ev.decoy_hit && isUntrustedReader(ev)) {
      add('HONEYTOKEN_READ', 'critical', actor, redactDetail(ev.detail));
    }
    if (type === 'fs_read' && isUntrustedReader(ev)) {
      add('HONEYTOKEN_READ', 'critical', actor, `read ${basename(ev.detail)}`);
    }

    // DECOY_EXFIL: a decoy value appears in outbound URL/body/DNS/argv. This is the smoking gun,
    // independent of enforce-mode blocking (a value leaving is proof even if we also blocked it).
    if (ev.decoy_hit && OUTBOUND_TYPES.has(type)) {
      add('DECOY_EXFIL', 'critical', actor, `${describeOutbound(ev)} carried a decoy value (blocked)`);
    }

    // EXFIL_ATTEMPT: connected/tried to connect to a host off the allowlist (marked "(blocked)").
    if (
      (type === 'net_connect' || type === 'dns_lookup' || type === 'http_request' || type === 'fetch') &&
      typeof ev.detail === 'string' &&
      ev.detail.includes('(blocked)')
    ) {
      add('EXFIL_ATTEMPT', 'critical', actor, redactDetail(ev.detail));
    }

    // SHIM_INVOKED: a package lifecycle script reached for curl/wget/nc.
    if (type === 'shim_invoked') {
      add('SHIM_INVOKED', 'critical', actor, redactDetail(ev.detail));
    }

    // ---- network summary (dedup by host, allowed flag from the "(blocked)" marker) ----
    collectNetwork(ev, network);
  }

  // ---- TAMPER (critical): integrity changes outside the package's own subtree ----
  const tampered = tamperedPaths(input.integrity, input.pkg);
  for (const t of tampered) {
    add('TAMPER', 'critical', input.pkg || 'package', `${t.change} ${t.path}`);
  }

  // ---- TIMEOUT (high) -------------------------------------------------------
  const timings = input.timings || {};
  if (timings.install_ms != null && timings.install_ms > 120000) {
    add('TIMEOUT', 'high', 'install', `install ran ${Math.round(timings.install_ms / 1000)}s (>120s)`);
  }
  if (timings.test_ms != null && timings.test_ms > 120000) {
    add('TIMEOUT', 'high', 'tests', `tests ran ${Math.round(timings.test_ms / 1000)}s (>120s)`);
  }

  // ---- NEW_INSTALL_SCRIPT + OBFUSCATION (high): both from static diff --------
  const diff = input.diff;
  if (diff) {
    const before = (diff.install_scripts && diff.install_scripts.before) || {};
    const after = (diff.install_scripts && diff.install_scripts.after) || {};
    const newScript = hasNewInstallScript(before, after);
    const obfuscated = Array.isArray(diff.suspicious) && diff.suspicious.some((s) => s && s.kind === 'obfuscation');
    if (newScript && obfuscated) {
      add('NEW_INSTALL_SCRIPT+OBFUSCATION', 'high', input.pkg || 'package', 'new install script with obfuscated code');
    }
  }

  // ---- FRESH_RELEASE (high) + info-only intel signals -----------------------
  const intel = input.intel;
  if (intel) {
    if (typeof intel.age_hours === 'number' && intel.age_hours < 24) {
      add('FRESH_RELEASE', 'high', input.pkg || 'package', `published ${intel.age_hours.toFixed(1)}h ago (<24h cooldown)`);
    }
    if (intel.has_provenance === false) {
      add('NO_PROVENANCE', 'info', input.pkg || 'package', 'no npm provenance attestation');
    }
    if (intel.maintainers_changed) {
      add('MAINTAINER_CHANGED', 'info', input.pkg || 'package', 'maintainer set changed in this range');
    }
    if (Array.isArray(intel.removed_versions_in_range) && intel.removed_versions_in_range.length) {
      const vs = intel.removed_versions_in_range.map((r) => r.version).join(', ');
      add('REMOVED_VERSIONS_IN_RANGE', 'info', input.pkg || 'package', `versions pulled from npm in range: ${vs}`);
    }
  }

  // ---- Rank, cap, and decide the verdict ------------------------------------
  const all = [...findings.values()].sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity]);
  const capped = all.slice(0, 12);

  const hasCritical = all.some((f) => f.severity === 'critical');
  const hasHigh = all.some((f) => f.severity === 'high');
  let verdict, severity;
  if (hasCritical) {
    verdict = 'BLOCKED';
    severity = 'critical';
  } else if (hasHigh) {
    verdict = 'INCONCLUSIVE';
    severity = 'high';
  } else {
    verdict = 'SAFE';
    severity = all.length ? 'info' : 'none';
  }

  return {
    verdict,
    severity,
    summary: summarize(verdict, capped, input.pkg),
    findings: capped,
    network: [...network.values()].slice(0, 10),
    tampered,
  };
}

// ---- helpers ----------------------------------------------------------------

function tamperedPaths(integrity, pkg) {
  if (!integrity) return [];
  const out = [];
  const seen = new Set();
  const push = (path, change) => {
    if (!path || isTamperIgnored(path, pkg)) return;
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, change });
  };
  for (const p of integrity.added || []) push(p, 'added');
  for (const p of integrity.modified || []) push(p, 'modified');
  for (const p of integrity.deleted || []) push(p, 'deleted');
  return out;
}

// Ignore the package's own node_modules subtree (its files are expected to appear on install),
// package-lock.json, and anything inside an npm cache dir.
function isTamperIgnored(path, pkg) {
  const p = String(path).replace(/\\/g, '/');
  if (p.endsWith('package-lock.json') || p.endsWith('/npm-shrinkwrap.json')) return true;
  if (p.includes('/.npm/') || p.includes('/_cacache/') || p.includes('/.npm-cache/')) return true;
  if (pkg) {
    // the package's own install location: node_modules/<pkg>/...
    const own = `node_modules/${pkg}/`;
    if (p.includes(own)) return true;
  }
  return false;
}

function collectNetwork(ev, network) {
  if (!ev || typeof ev.detail !== 'string') return;
  const type = ev.type;
  if (type !== 'net_connect' && type !== 'dns_lookup' && type !== 'http_request' && type !== 'fetch') return;
  const host = extractHost(ev.detail);
  if (!host) return;
  const allowed = !ev.detail.includes('(blocked)');
  const actor = ev.actor && ev.actor.pkg ? ev.actor.pkg : 'unknown';
  // Prefer a "blocked" record over an "allowed" one if we've seen both for a host.
  const existing = network.get(host);
  if (!existing || (existing.allowed && !allowed)) {
    network.set(host, { host, allowed, actor });
  }
}

function extractHost(detail) {
  // detail forms: "connect evil.invalid:443 (blocked)", "fetch host (blocked)", "lookup host (blocked)",
  // "https.get host (blocked)". Grab the first token that looks like a host.
  const m = detail.match(/(?:connect|fetch|lookup|get|request)\s+([a-zA-Z0-9._-]+)/);
  if (m) return m[1].split(':')[0];
  return null;
}

function describeOutbound(ev) {
  switch (ev.type) {
    case 'shim_invoked':
      return 'lifecycle script network call';
    case 'child_process':
      return 'child process argv';
    case 'exfil_body':
      return 'request body';
    case 'fetch':
    case 'http_request':
      return 'outbound request';
    case 'net_connect':
      return 'socket connection';
    case 'dns_lookup':
      return 'DNS lookup';
    default:
      return 'outbound data';
  }
}

function hasNewInstallScript(before, after) {
  const life = ['preinstall', 'install', 'postinstall'];
  for (const k of life) {
    if (after[k] && !before[k]) return true;
  }
  return false;
}

function basename(detail) {
  if (typeof detail !== 'string') return String(detail || '');
  // detail like "readFileSync /path/to/home/.npmrc" -> ".npmrc" (never echo the full path/value)
  const parts = detail.trim().split(/\s+/);
  const last = parts[parts.length - 1] || detail;
  const seg = last.replace(/\\/g, '/').split('/');
  return seg[seg.length - 1] || last;
}

// Never let a decoy value leak into a finding detail (findings land in the model context / report card).
function redactDetail(detail) {
  if (typeof detail !== 'string') return String(detail || '');
  return detail.replace(/(?:npm_DECOY_|ghp_DECOY_|AKIADECOY|DECOY\/)[\w.\-\/]*/g, '<decoy>');
}

function summarize(verdict, findings, pkg) {
  const name = pkg || 'the dependency';
  if (verdict === 'SAFE') return `${name}: no dangerous behaviour observed during install or tests`;
  const top = findings[0];
  if (verdict === 'BLOCKED') {
    const crit = findings.filter((f) => f.severity === 'critical');
    const rules = [...new Set(crit.map((f) => f.rule))].slice(0, 4).join(', ');
    return `${name} BLOCKED: ${top ? top.detail : rules} [${rules}]`;
  }
  // INCONCLUSIVE
  const highs = findings.filter((f) => f.severity === 'high').map((f) => f.rule);
  return `${name} INCONCLUSIVE: ${[...new Set(highs)].join(', ') || 'unverified signal'}`;
}
