#!/usr/bin/env node
// chamber.mjs — the supply-chain gate CLI, runs INSIDE the Daytona sandbox.
//   node bin/chamber.mjs <detonate|test|diff|heal|manifest|bootstrap> [flags]
// Each subcommand prints EXACTLY ONE JSON object on stdout (< 4 KB) and logs to stderr.
// Exit 0 even for a BLOCKED verdict; non-zero only on a crash (the agent then treats it as INCONCLUSIVE).
//
// Owned by B: detonate, test, diff, heal (+ the shared room/env/spawn helpers below).
// Owned by C: manifest (lib/manifest.mjs), registered through the same dispatcher.
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
import { isScannable, scanSource, installScripts, OBFUSCATION_KINDS } from '../lib/scan.mjs';

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
// detonate — core. Returns the §4.1 verdict object (also carries `room_dir` for callers
// like heal that need to burn the room). The CLI wrapper below prints it; heal calls this
// directly, up to 3 times, so it must never emit or exit on its own.
// ---------------------------------------------------------------------------
function detonate(args) {
  const { repo, base, package: pkgName, to } = args;
  if (!repo || !base || !pkgName || !to) {
    return { cmd: 'detonate', error: 'missing --repo/--base/--package/--to' };
  }
  const roomId = newRoomId();
  const room = makeRoom(roomId);
  const projectDir = path.join(room, 'project');
  loge(`[${roomId}] cloning ${repo} @ ${base}`);

  const cl = cloneAt(repo, base, projectDir);
  if (!cl.ok) {
    // Nothing was installed, so nothing was observed: INCONCLUSIVE, never SAFE.
    return { cmd: 'detonate', room: roomId, room_dir: room, package: pkgName, to, verdict: 'INCONCLUSIVE', severity: 'high', summary: `could not clone ${repo} at ${base}`, error: `clone failed: ${cl.error}`, findings: [], network: [], tampered: [], install: { exit_code: null, duration_ms: 0 }, tests: { ran: false }, log_ok: false };
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

  return {
    cmd: 'detonate',
    room: roomId,
    room_dir: room, // for callers that burn the room; stripped before the CLI prints
    package: pkgName,
    from: shortSpec(fromSpec),
    to: shortSpec(to),
    section,
    verdict: verdict.verdict,
    severity: verdict.severity,
    summary: verdict.summary,
    findings: verdict.findings,
    network: verdict.network,
    tampered: verdict.tampered,
    install: { exit_code: install.exit_code, duration_ms: install.duration_ms },
    tests,
    log_ok: logOk,
  };
}

// CLI wrapper: run detonate, strip the internal room_dir, print one JSON object.
function cmdDetonate(args) {
  const r = detonate(args);
  emit(stripInternal(r));
  return 0;
}

// Fields prefixed for internal use (room_dir) never go to the model's context.
function stripInternal(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { room_dir, ...rest } = obj;
  return rest;
}

// Burn a room: remove its directory tree. Best-effort; never throws.
function burnRoom(roomDir) {
  try {
    if (roomDir && roomDir.startsWith(CHAMBER_ROOT)) fs.rmSync(roomDir, { recursive: true, force: true });
  } catch (e) {
    loge('burn failed', String(e && e.message));
  }
}

// ---------------------------------------------------------------------------
// test — fresh room, install + npm test under tripwire (enforce), with optional pins
// ---------------------------------------------------------------------------
function runTest(args) {
  const { repo, ref } = args;
  if (!repo || !ref) {
    return { cmd: 'test', error: 'missing --repo/--ref' };
  }
  const roomId = newRoomId();
  const room = makeRoom(roomId);
  const projectDir = path.join(room, 'project');

  const cl = cloneAt(repo, ref, projectDir);
  if (!cl.ok) {
    // Tests never ran: null counts, so "failed is 0" can't be mistaken for a pass.
    return { cmd: 'test', room: roomId, room_dir: room, ref, passed: null, failed: null, duration_ms: 0, verdict: 'INCONCLUSIVE', error: `clone failed: ${cl.error}`, findings: [] };
  }

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
  return {
    cmd: 'test',
    room: roomId,
    room_dir: room,
    ref,
    pins: args.pin || [],
    passed,
    failed,
    exit_code: t.exit_code,
    duration_ms: t.duration_ms,
    install: { exit_code: install.exit_code, duration_ms: install.duration_ms },
    verdict: verdict.verdict,
    findings: verdict.findings.slice(0, 8),
  };
}

function cmdTest(args) {
  emit(stripInternal(runTest(args)));
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
// diff — static comparison of two versions of ONE dependency (no install, no scripts).
//   npm spec:  npm pack <name>@<v> --ignore-scripts  → tar -x
//   git spec:  clone at the ref (git+... / github:... / a bare tag)
// Flags new install scripts, obfuscation, and new network / child_process use.
// ---------------------------------------------------------------------------
function cmdDiff(args) {
  const { package: pkgName, from, to } = args;
  if (!pkgName || !from || !to) {
    emit({ cmd: 'diff', error: 'missing --package/--from/--to' });
    return 0;
  }
  const scratch = fs.mkdtempSync(path.join(CHAMBER_ROOT, 'diff-'));
  fs.mkdirSync(scratch, { recursive: true });
  try {
    const beforeDir = materialize(pkgName, from, path.join(scratch, 'before'));
    const afterDir = materialize(pkgName, to, path.join(scratch, 'after'));
    if (!beforeDir.ok || !afterDir.ok) {
      emit({ cmd: 'diff', package: pkgName, from, to, error: `could not fetch: ${beforeDir.error || afterDir.error}`, files_added: [], files_changed: [], install_scripts: { before: {}, after: {} }, suspicious: [] });
      return 0;
    }

    const beforeFiles = fileHashMap(beforeDir.dir);
    const afterFiles = fileHashMap(afterDir.dir);
    const files_added = [];
    const files_changed = [];
    for (const p of Object.keys(afterFiles)) {
      if (!(p in beforeFiles)) files_added.push(p);
      else if (beforeFiles[p] !== afterFiles[p]) files_changed.push(p);
    }
    files_added.sort();
    files_changed.sort();

    const install_scripts = {
      before: installScripts(readIf(path.join(beforeDir.dir, 'package.json'))),
      after: installScripts(readIf(path.join(afterDir.dir, 'package.json'))),
    };

    // Scan only files that are new or changed in the new version — that's where a payload lands.
    const suspicious = [];
    const toScan = [...files_added, ...files_changed];
    for (const rel of toScan) {
      if (!isScannable(rel)) continue;
      const contents = readIf(path.join(afterDir.dir, rel));
      for (const f of scanSource(rel, contents)) {
        suspicious.push(f);
        if (suspicious.length >= 20) break;
      }
      if (suspicious.length >= 20) break;
    }

    emit({
      cmd: 'diff',
      package: pkgName,
      from,
      to,
      files_added: files_added.slice(0, 40),
      files_changed: files_changed.slice(0, 40),
      install_scripts,
      suspicious,
    });
    return 0;
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}

// Materialize one version of a package into `dest`. Returns {ok, dir, error}.
// `dir` is the directory that directly contains package.json.
function materialize(name, spec, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (isGitSpec(spec)) {
    const { url, ref } = parseGitSpec(spec, name);
    const cl = cloneAt(url, ref, dest);
    if (!cl.ok) return { ok: false, error: cl.error };
    return { ok: true, dir: dest };
  }
  // npm: `npm pack` writes a .tgz; extract it. Use a decoy-free plain env (no tripwire needed here —
  // --ignore-scripts means no package code runs).
  const version = spec; // for npm, `spec` is a version or range; pack resolves it
  const packEnv = { ...process.env, npm_config_cache: NPM_CACHE };
  const r = run('npm', ['pack', `${name}@${version}`, '--ignore-scripts', '--pack-destination', dest], {
    cwd: dest,
    env: packEnv,
    timeout: STEP_TIMEOUT_MS,
  });
  if (r.exit_code !== 0) return { ok: false, error: (r.stderr || r.error || 'npm pack failed').split('\n').pop().slice(0, 160) };
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (!tgz) return { ok: false, error: 'npm pack produced no tarball' };
  const ex = run('tar', ['-xzf', path.join(dest, tgz), '-C', dest], { cwd: dest, timeout: 30000 });
  if (ex.exit_code !== 0) return { ok: false, error: 'tar extract failed' };
  // npm tarballs unpack under package/
  const pkgDir = path.join(dest, 'package');
  return { ok: true, dir: fs.existsSync(path.join(pkgDir, 'package.json')) ? pkgDir : dest };
}

function isGitSpec(spec) {
  return /^(git\+|github:|git:|https?:\/\/.*\.git|git@)/.test(String(spec)) || String(spec).includes('#');
}

// Turn a git dependency spec into {url, ref}. Handles github:ORG/REPO#ref, git+file://…#ref,
// git+https://…#ref, and plain https://…​.git#ref.
function parseGitSpec(spec, name) {
  let s = String(spec);
  let ref = 'HEAD';
  const hash = s.lastIndexOf('#');
  if (hash !== -1) {
    ref = s.slice(hash + 1);
    s = s.slice(0, hash);
  }
  s = s.replace(/^git\+/, '');
  if (s.startsWith('github:')) s = 'https://github.com/' + s.slice('github:'.length) + '.git';
  return { url: s, ref };
}

// sha256 map of a directory's files (skip node_modules/.git), for the added/changed comparison.
function fileHashMap(dir) {
  const map = {};
  const walk = (d, base) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      try {
        if (e.isDirectory()) walk(full, base);
        else if (e.isFile()) map[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      } catch {}
    }
  };
  walk(dir, dir);
  return map;
}

function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// heal — recover from a BLOCKED dependency (SPEC §4.2).
//   1. burn the bad room (if the caller passed one via --bad-room, else nothing to burn yet)
//   2. list candidate earlier versions/tags, newest first, skipping deprecated/removed
//   3. detonate up to 3 in fresh rooms until one is SAFE
//   4. run the project's tests with that pin
//   → {status: HEALED | NO_SAFE_VERSION | INCONCLUSIVE, ...}
// ---------------------------------------------------------------------------
const MAX_HEAL_CANDIDATES = 3;

function cmdHeal(args) {
  const { repo, base, package: pkgName, bad } = args;
  if (!repo || !base || !pkgName || !bad) {
    emit({ cmd: 'heal', error: 'missing --repo/--base/--package/--bad' });
    return 0;
  }
  const section = args.section || undefined;

  // (1) Burn the contaminated room if the agent told us which one (detonate returns `room`).
  let burned_room = null;
  if (args['bad-room']) {
    const dir = path.join(CHAMBER_ROOT, String(args['bad-room']));
    burnRoom(dir);
    burned_room = String(args['bad-room']);
    loge(`[heal] burned ${burned_room}`);
  }

  // (2) Candidate earlier versions, newest first.
  let candidatesList;
  try {
    candidatesList = listCandidates(pkgName, bad);
  } catch (e) {
    loge('[heal] candidate listing failed', String(e && e.message));
    candidatesList = [];
  }
  if (!candidatesList.length) {
    emit({ cmd: 'heal', package: pkgName, bad, status: 'NO_SAFE_VERSION', burned_room, candidates: [], safe: null, reason: 'no earlier version found to fall back to' });
    return 0;
  }

  // (3) Detonate candidates (up to MAX) until SAFE.
  const tried = [];
  let safeSpec = null;
  let safeRoomVerdict = null;
  for (const spec of candidatesList.slice(0, MAX_HEAL_CANDIDATES)) {
    loge(`[heal] detonating candidate ${spec}`);
    const v = detonate({ repo, base, package: pkgName, to: spec, section });
    tried.push({ spec: shortSpec(spec), verdict: v.verdict, room: v.room });
    // burn every candidate room; a SAFE one gets re-verified fresh in the test step anyway
    burnRoom(v.room_dir);
    if (v.verdict === 'SAFE') {
      safeSpec = spec;
      safeRoomVerdict = v;
      break;
    }
  }

  if (!safeSpec) {
    const anyInconclusive = tried.some((t) => t.verdict === 'INCONCLUSIVE');
    emit({
      cmd: 'heal',
      package: pkgName,
      bad: shortSpec(bad),
      status: anyInconclusive ? 'INCONCLUSIVE' : 'NO_SAFE_VERSION',
      burned_room,
      candidates: tried,
      safe: null,
      reason: anyInconclusive ? 'no candidate came back SAFE (some were INCONCLUSIVE)' : 'no candidate came back SAFE',
    });
    return 0;
  }

  const pinSection = safeRoomVerdict.section || section || 'devDependencies';
  const pin = { section: pinSection, name: pkgName, spec: shortSpec(safeSpec) };

  // (4) Fresh room: install the project with the pin and run its tests.
  loge(`[heal] verifying pin in a fresh room + tests`);
  const t = runTest({ repo, ref: base, pin: [`${pkgName}=${safeSpec}`] });
  burnRoom(t.room_dir);
  const fresh_room_clean = t.verdict === 'SAFE';
  const testsPassed = t.failed === 0 && t.exit_code === 0;

  emit({
    cmd: 'heal',
    package: pkgName,
    bad: shortSpec(bad),
    status: fresh_room_clean && testsPassed ? 'HEALED' : 'INCONCLUSIVE',
    burned_room,
    malware_changes: (safeRoomVerdict && safeRoomVerdict.tampered ? [] : []), // tamper belongs to the bad room; agent already has it from detonate
    candidates: tried,
    safe: shortSpec(safeSpec),
    pin,
    fresh_room_clean,
    tests: { passed: t.passed, failed: t.failed },
  });
  return 0;
}

// List earlier versions/tags of a package than `bad`, newest first, skipping deprecated/removed.
// npm: `npm view <name> versions` + `deprecated`. git: `git ls-remote --tags`.
function listCandidates(name, bad) {
  if (isGitSpec(bad)) {
    const { url, ref: badRef } = parseGitSpec(bad, name);
    const r = run('git', ['ls-remote', '--tags', '--refs', url], { timeout: 30000, env: GIT_ENV });
    if (r.exit_code !== 0) return [];
    const tags = r.stdout
      .split('\n')
      .map((l) => l.split('\t')[1])
      .filter(Boolean)
      .map((ref) => ref.replace('refs/tags/', ''));
    const badV = cleanVersion(badRef);
    const lower = tags
      .filter((t) => {
        const v = cleanVersion(t);
        return v && badV && compareSemver(v, badV) < 0;
      })
      .sort((a, b) => compareSemver(cleanVersion(b), cleanVersion(a)));
    // rebuild full git specs preserving the original url shape (github:… or git+…)
    const prefix = bad.slice(0, bad.lastIndexOf('#') + 1);
    return lower.map((t) => prefix + t);
  }
  // npm
  const r = run('npm', ['view', name, 'versions', '--json'], { timeout: 30000, env: { ...process.env, npm_config_cache: NPM_CACHE } });
  if (r.exit_code !== 0) return [];
  let versions;
  try {
    versions = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(versions)) versions = [versions];
  const badV = cleanVersion(bad);
  const lower = versions.filter((v) => badV && compareSemver(v, badV) < 0).sort((a, b) => compareSemver(b, a));
  // Skip deprecated versions (one batched view call).
  const skip = deprecatedVersions(name);
  return lower.filter((v) => !skip.has(v));
}

function deprecatedVersions(name) {
  const skip = new Set();
  try {
    const r = run('npm', ['view', name, 'versions.deprecated', '--json'], { timeout: 20000, env: { ...process.env, npm_config_cache: NPM_CACHE } });
    if (r.exit_code === 0 && r.stdout.trim()) {
      const dep = JSON.parse(r.stdout);
      if (dep && typeof dep === 'object') for (const k of Object.keys(dep)) if (dep[k]) skip.add(k);
    }
  } catch {}
  return skip;
}

function cleanVersion(s) {
  const m = String(s).match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  return m ? m[0] : null;
}

// Minimal semver compare (major.minor.patch, prerelease sorts before release). Returns -1/0/1.
function compareSemver(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split(/[-+]/);
  const pb = String(b).replace(/^[^\d]*/, '').split(/[-+]/);
  const na = pa[0].split('.').map((n) => parseInt(n, 10) || 0);
  const nb = pb[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) < (nb[i] || 0) ? -1 : 1;
  }
  // release > prerelease
  const preA = pa[1] || '';
  const preB = pb[1] || '';
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA < preB) return -1;
  if (preA > preB) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
const COMMANDS = {
  detonate: cmdDetonate,
  test: cmdTest,
  diff: cmdDiff,
  heal: cmdHeal,
  // manifest: owned by C (lib/manifest.mjs)
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
// This lets C's manifest command live in a sibling module that imports the helpers below
// without triggering the dispatcher / process.exit.
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

// Export helpers so C's manifest command (and any other importer) can reuse the room machinery.
export {
  detonate,
  runTest,
  makeRoom,
  roomEnv,
  run,
  cloneAt,
  burnRoom,
  pinDependency,
  applyPins,
  readEvents,
  newRoomId,
  parseNodeTestCounts,
  materialize,
  emit,
  loge,
  parseArgs,
  COMMANDS,
  SKILL_ROOT,
  CHAMBER_ROOT,
};
