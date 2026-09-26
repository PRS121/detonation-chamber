#!/usr/bin/env node
// chamber.mjs — the supply-chain gate CLI, runs INSIDE the Daytona sandbox.
//   node bin/chamber.mjs <detonate|test|diff|heal|manifest|bootstrap> [flags]
// Each subcommand prints EXACTLY ONE JSON object on stdout (< 4 KB) and logs to stderr.
// Exit 0 even for a BLOCKED verdict; non-zero only on a crash (the agent then treats it as INCONCLUSIVE).
//
// Owned by B: detonate, test (+ the shared room/env/spawn helpers below).
// Owned by C: diff, heal, manifest (registered through the same dispatcher).
//
// Zero npm deps; Node built-ins only; must run on Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { snapshot, diff as integrityDiff } from '../lib/integrity.mjs';
import { evaluate } from '../lib/rules.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIPWIRE = path.join(SKILL_ROOT, 'lib', 'tripwire.cjs');
const SHIMS_DIR = path.join(SKILL_ROOT, 'shims');
const CHAMBER_ROOT = process.env.CHAMBER_ROOT || path.join(os.tmpdir(), 'chamber');
const NPM_CACHE = path.join(CHAMBER_ROOT, '.npm-cache');
const ALLOWLIST = 'registry.npmjs.org,github.com,codeload.github.com,objects.githubusercontent.com';
const STEP_TIMEOUT_MS = 120000; // §5 TIMEOUT threshold; also our hard cap per step

// ---------------------------------------------------------------------------
// stdout / stderr discipline: one JSON object on stdout, everything else stderr.
// ---------------------------------------------------------------------------
function emit(obj) {
  let s = JSON.stringify(obj);
  if (s.length > 4096) s = JSON.stringify(trimForBudget(obj)); // keep under the 4 KB context budget
  process.stdout.write(s + '\n');
}
function loge(...a) {
  process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}
function trimForBudget(obj) {
  const o = { ...obj };
  if (Array.isArray(o.findings)) o.findings = o.findings.slice(0, 8);
  if (Array.isArray(o.network)) o.network = o.network.slice(0, 6);
  if (Array.isArray(o.tampered)) o.tampered = o.tampered.slice(0, 6);
  return o;
}

// ---------------------------------------------------------------------------
// arg parsing: --flag value, --flag=value, boolean --run-tests.
// --pin is repeatable (`test --pin a=1 --pin b=2`) and always comes back as an array.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        i++;
      }
    }
    if (key === 'pin') {
      out.pin = out.pin || [];
      out.pin.push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Room: /tmp/chamber/<room>/ with home/ project/ bin/ log/ baseline.json
// ---------------------------------------------------------------------------
function newRoomId() {
  return 'r-' + crypto.randomBytes(2).toString('hex');
}

function makeRoom(roomId) {
  const room = path.join(CHAMBER_ROOT, roomId);
  for (const sub of ['home', 'project', 'bin', 'log']) {
    fs.mkdirSync(path.join(room, sub), { recursive: true });
  }
  fs.mkdirSync(NPM_CACHE, { recursive: true });
  copyShims(path.join(room, 'bin'));
  plantDecoys(path.join(room, 'home'), roomId);
  return room;
}

function copyShims(dstBin) {
  for (const name of ['curl', 'wget', 'nc']) {
    const src = path.join(SHIMS_DIR, name);
    const dst = path.join(dstBin, name);
    try {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    } catch (e) {
      loge('shim copy failed', name, String(e.message));
    }
  }
}

// Decoy HOME. Values are unique per room so any decoy seen in outbound data proves exfil.
// NEVER put a decoy under //registry.npmjs.org/:_authToken (npm would 401). Use the GitHub registry line.
function decoyValues(roomId) {
  return {
    NPM_TOKEN: `npm_DECOY_${roomId}`,
    GITHUB_TOKEN: `ghp_DECOY_${roomId}`,
    AWS_ACCESS_KEY_ID: `AKIADECOY${roomId.replace(/-/g, '')}`,
    AWS_SECRET_ACCESS_KEY: `DECOY/${roomId}`,
  };
}

function plantDecoys(home, roomId) {
  const d = decoyValues(roomId);
  const write = (rel, content) => {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('.npmrc', `//npm.pkg.github.com/:_authToken=${d.GITHUB_TOKEN}\n`);
  write('.aws/credentials', `[default]\naws_access_key_id=${d.AWS_ACCESS_KEY_ID}\naws_secret_access_key=${d.AWS_SECRET_ACCESS_KEY}\n`);
  write('.ssh/id_ed25519', `-----BEGIN OPENSSH PRIVATE KEY-----\nDECOY-${roomId}-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n`);
  write('.config/gh/hosts.yml', `github.com:\n    oauth_token: ${d.GITHUB_TOKEN}\n    user: decoy\n`);
}

// Environment for install/test processes (§6). `mode` is enforce or monitor.
function roomEnv(room, roomId, mode = 'enforce') {
  const d = decoyValues(roomId);
  const shimPath = path.join(room, 'bin');
  return {
    ...process.env,
    HOME: path.join(room, 'home'),
    PATH: shimPath + path.delimiter + (process.env.PATH || ''),
    CI: 'true',
    CHAMBER_LAB: '1',
    NODE_OPTIONS: `--require ${TRIPWIRE}`,
    TRIPWIRE_LOG: path.join(room, 'log', 'events.jsonl'),
    TRIPWIRE_MODE: mode,
    TRIPWIRE_ALLOW: ALLOWLIST,
    npm_config_cache: NPM_CACHE,
    ...d,
  };
}

// ---------------------------------------------------------------------------
// spawn helper: run a command, capped, capture timing + exit code (never throws)
// ---------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || STEP_TIMEOUT_MS,
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  const duration_ms = Date.now() - started;
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  return {
    exit_code: typeof res.status === 'number' ? res.status : timedOut ? 124 : 1,
    duration_ms,
    timedOut: !!timedOut,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error ? String(res.error.message) : null,
  };
}

// git clone at a ref, autocrlf off, shallow. Returns {ok, error}.
// GIT_TERMINAL_PROMPT=0: a private or mistyped repo fails fast instead of waiting for a password.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
function cloneAt(repoUrl, ref, dest) {
  // Tags and branches: shallow clone. Commit shas (the agent's usual input) can't go through
  // --branch, so they skip straight to a full clone + checkout.
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
    const r = run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', ref, repoUrl, dest], {
      timeout: STEP_TIMEOUT_MS,
      env: GIT_ENV,
    });
    if (r.exit_code === 0) return { ok: true };
    loge('shallow clone of', ref, 'failed, retrying with a full clone:', gitError(r));
    fs.rmSync(dest, { recursive: true, force: true });
  }
  const c = run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', repoUrl, dest], { timeout: STEP_TIMEOUT_MS, env: GIT_ENV });
  if (c.exit_code !== 0) return { ok: false, error: gitError(c) };
  const co = run('git', ['-C', dest, '-c', 'core.autocrlf=false', 'checkout', '--quiet', ref], { timeout: 30000, env: GIT_ENV });
  if (co.exit_code !== 0) return { ok: false, error: gitError(co) };
  return { ok: true };
}

// The line of git's stderr that says what went wrong, without the "Cloning into '<path>'" noise.
function gitError(res) {
  if (res.timedOut) return 'git timed out';
  const lines = String(res.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => l.startsWith('fatal:') || l.startsWith('error:'));
  return (fatal || lines[lines.length - 1] || res.error || 'git failed').slice(0, 200);
}

// Set exactly one dependency in package.json to `spec`, in `section`.
function pinDependency(projectDir, section, name, spec) {
  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const sec = section || (pkg.devDependencies && pkg.devDependencies[name] ? 'devDependencies' : 'dependencies');
  pkg[sec] = pkg[sec] || {};
  pkg[sec][name] = spec;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return sec;
}

// Parse the tripwire JSONL log. Returns {events, logOk}.
function readEvents(room) {
  const logPath = path.join(room, 'log', 'events.jsonl');
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // one bad line doesn't sink the log, but note it
      }
    }
    return { events, logOk: true };
  } catch {
    return { events: [], logOk: false };
  }
}

// short "from"/"to" display specs for the verdict card
function shortSpec(spec) {
  return String(spec);
}

// ---------------------------------------------------------------------------
// detonate
// ---------------------------------------------------------------------------
function cmdDetonate(args) {
  const { repo, base, package: pkgName, to } = args;
  if (!repo || !base || !pkgName || !to) {
    emit({ cmd: 'detonate', error: 'missing --repo/--base/--package/--to' });
    return 0;
  }
  const roomId = newRoomId();
  const room = makeRoom(roomId);
  const projectDir = path.join(room, 'project');
  loge(`[${roomId}] cloning ${repo} @ ${base}`);

  const cl = cloneAt(repo, base, projectDir);
  if (!cl.ok) {
    // Nothing was installed, so nothing was observed: INCONCLUSIVE, never SAFE.
    emit({ cmd: 'detonate', room: roomId, package: pkgName, to, verdict: 'INCONCLUSIVE', severity: 'high', summary: `could not clone ${repo} at ${base}`, error: `clone failed: ${cl.error}`, findings: [], network: [], tampered: [], install: { exit_code: null, duration_ms: 0 }, tests: { ran: false }, log_ok: false });
    return 0;
  }

  // read the "from" spec (current value) before we overwrite it
  let fromSpec = base;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    fromSpec = (pkg.dependencies && pkg.dependencies[pkgName]) || (pkg.devDependencies && pkg.devDependencies[pkgName]) || base;
  } catch {}

  const section = pinDependency(projectDir, args.section, pkgName, to);
  loge(`[${roomId}] pinned ${section}.${pkgName} = ${to}`);

  // baseline BEFORE install: project/ + home/ (home so a decoy-file rewrite would show, though rare)
  const baseProject = snapshot(projectDir);
  fs.writeFileSync(path.join(room, 'baseline.json'), JSON.stringify({ project: baseProject }));

  const env = roomEnv(room, roomId, 'enforce');
  loge(`[${roomId}] npm install (scripts ON) under tripwire`);
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts'], {
    cwd: projectDir,
    env,
    timeout: STEP_TIMEOUT_MS,
  });
  loge(`[${roomId}] install exit=${install.exit_code} ${install.duration_ms}ms`);

  // integrity diff after install
  const afterProject = snapshot(projectDir);
  const integrity = integrityDiff(baseProject, afterProject);

  // optional tests
  let tests = { ran: false };
  let testTiming = null;
  if (args['run-tests']) {
    loge(`[${roomId}] npm test under tripwire`);
    const t = run('npm', ['test'], { cwd: projectDir, env, timeout: STEP_TIMEOUT_MS });
    testTiming = t.duration_ms;
    const counts = parseNodeTestCounts(t.stdout + '\n' + t.stderr, t.exit_code);
    tests = { ran: true, passed: counts.passed, failed: counts.failed, exit_code: t.exit_code, duration_ms: t.duration_ms };
  }

  const { events, logOk } = readEvents(room);
  const verdict = evaluate({
    events,
    logOk,
    integrity,
    pkg: pkgName,
    timings: { install_ms: install.timedOut ? STEP_TIMEOUT_MS + 1 : install.duration_ms, test_ms: testTiming },
  });

  emit({
    cmd: 'detonate',
    room: roomId,
    package: pkgName,
    from: shortSpec(fromSpec),
    to: shortSpec(to),
    verdict: verdict.verdict,
    severity: verdict.severity,
    summary: verdict.summary,
    findings: verdict.findings,
    network: verdict.network,
    tampered: verdict.tampered,
    install: { exit_code: install.exit_code, duration_ms: install.duration_ms },
    tests,
    log_ok: logOk,
  });
  return 0;
}

// ---------------------------------------------------------------------------
// test — fresh room, install + npm test under tripwire (enforce), with optional pins
// ---------------------------------------------------------------------------
function cmdTest(args) {
  const { repo, ref } = args;
  if (!repo || !ref) {
    emit({ cmd: 'test', error: 'missing --repo/--ref' });
    return 0;
  }
  const roomId = newRoomId();
  const room = makeRoom(roomId);
  const projectDir = path.join(room, 'project');

  const cl = cloneAt(repo, ref, projectDir);
  if (!cl.ok) {
    // Tests never ran: null counts, so "failed is 0" can't be mistaken for a pass.
    emit({ cmd: 'test', room: roomId, ref, passed: null, failed: null, duration_ms: 0, verdict: 'INCONCLUSIVE', error: `clone failed: ${cl.error}`, findings: [] });
    return 0;
  }

  // apply pins: --pin name=spec (repeatable → parseArgs keeps the last; accept comma-separated too)
  applyPins(projectDir, args.pin);

  const baseProject = snapshot(projectDir);
  const env = roomEnv(room, roomId, 'enforce');

  const install = run('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts'], { cwd: projectDir, env });
  const t = run('npm', ['test'], { cwd: projectDir, env });
  const afterProject = snapshot(projectDir);
  const integrity = integrityDiff(baseProject, afterProject);
  const { events, logOk } = readEvents(room);

  const verdict = evaluate({
    events,
    logOk,
    integrity,
    pkg: null,
    timings: { install_ms: install.duration_ms, test_ms: t.timedOut ? STEP_TIMEOUT_MS + 1 : t.duration_ms },
  });

  const { passed, failed } = parseNodeTestCounts(t.stdout + '\n' + t.stderr, t.exit_code);
  emit({
    cmd: 'test',
    room: roomId,
    ref,
    pins: args.pin || [],
    passed,
    failed,
    exit_code: t.exit_code,
    duration_ms: t.duration_ms,
    install: { exit_code: install.exit_code, duration_ms: install.duration_ms },
    verdict: verdict.verdict,
    findings: verdict.findings.slice(0, 8),
  });
  return 0;
}

function applyPins(projectDir, pin) {
  if (!pin) return;
  const pins = Array.isArray(pin) ? pin : [pin];
  for (const raw of pins) {
    for (const part of String(raw).split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const spec = part.slice(eq + 1).trim();
      if (name && spec) {
        try {
          pinDependency(projectDir, undefined, name, spec);
        } catch (e) {
          loge('pin failed', name, String(e.message));
        }
      }
    }
  }
}

// node --test summary lines: "# pass N" (tap reporter) or "ℹ pass N" (spec reporter).
// Fallback to the exit code if neither is found.
function parseNodeTestCounts(output, exitCode) {
  let passed = 0;
  let failed = 0;
  const pass = output.match(/(?:#|ℹ)\s*pass\s+(\d+)/);
  const fail = output.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
  if (pass) passed = parseInt(pass[1], 10);
  if (fail) failed = parseInt(fail[1], 10);
  if (!pass && !fail) {
    // couldn't parse; infer from exit code
    if (exitCode === 0) passed = 1;
    else failed = 1;
  }
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// dispatcher — C's subcommands (diff, heal, manifest) register here.
// ---------------------------------------------------------------------------
const COMMANDS = {
  detonate: cmdDetonate,
  test: cmdTest,
  // diff, heal, manifest: owned by C (added in their commits)
};

function main() {
  const [, , cmd, ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    emit({ error: `unknown command: ${cmd || '(none)'}`, commands: Object.keys(COMMANDS) });
    process.exit(0);
  }
  const args = parseArgs(rest);
  let code = 0;
  try {
    code = fn(args) || 0;
  } catch (e) {
    // A crash → non-zero so the agent treats it as INCONCLUSIVE. Never leak env in the message.
    loge('CRASH', String((e && e.stack) || e));
    emit({ cmd, error: 'chamber crashed: ' + String((e && e.message) || e).slice(0, 200) });
    code = 1;
  }
  process.exit(code);
}

// Run the CLI only when executed directly (node chamber.mjs …), NOT when imported.
// This lets C's diff/heal/manifest live in sibling modules that import the helpers below
// without triggering the dispatcher / process.exit.
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

// Export helpers so C's subcommands (diff/heal/manifest) can reuse the room machinery.
export {
  makeRoom,
  roomEnv,
  run,
  cloneAt,
  pinDependency,
  applyPins,
  readEvents,
  newRoomId,
  parseNodeTestCounts,
  emit,
  loge,
  parseArgs,
  COMMANDS,
  SKILL_ROOT,
  CHAMBER_ROOT,
};
