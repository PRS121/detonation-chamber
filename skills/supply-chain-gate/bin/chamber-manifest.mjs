// chamber-manifest.mjs — the `manifest` subcommand (SPEC §3), owned by C.
// Runs INSIDE the sandbox. Registered into chamber.mjs's dispatcher (import + one COMMANDS entry).
// Reuses B's room/clone/spawn helpers via import; hashing lives in ../lib/manifest.mjs (shared with the host).
//
// Zero npm deps; Node built-ins only; must run on Node 18+.

import fs from 'node:fs';
import path from 'node:path';

import { newRoomId, cloneAt, run, emit, CHAMBER_ROOT } from './chamber.mjs';
import { computeManifest } from '../lib/manifest.mjs';

// CHAMBER_ROOT is a `const` export of chamber.mjs: because of the circular import it is still in the
// temporal dead zone while THIS module is being evaluated, so read it only at call time.
const npmEnv = () => ({ ...process.env, npm_config_cache: path.join(CHAMBER_ROOT, '.npm-cache'), GIT_TERMINAL_PROMPT: '0' });

// manifest — clone an exact commit, list the packed files, hash their bytes (SPEC §3).
// Same module the host runs before publishing, so "the bytes we tested are the bytes we ship".
export function cmdManifest(args) {
  const { repo, ref } = args;
  if (!repo || !ref) {
    emit({ cmd: 'manifest', error: 'missing --repo/--ref' });
    return 0;
  }
  const dir = path.join(CHAMBER_ROOT, newRoomId() + '-manifest');
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  const cl = cloneAt(repo, ref, projectDir);
  if (!cl.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    emit({ cmd: 'manifest', repo, ref, error: `clone failed: ${cl.error}` });
    return 0;
  }
  let name = null;
  let version = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    name = pkg.name;
    version = pkg.version;
  } catch {}

  const packed = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: projectDir, env: npmEnv() });
  let files = null;
  if (packed.exit_code === 0) {
    try {
      files = (JSON.parse(packed.stdout)[0].files || []).map((f) => f.path);
    } catch {}
  }
  if (!files) {
    fs.rmSync(dir, { recursive: true, force: true });
    emit({ cmd: 'manifest', repo, ref, name, version, error: 'npm pack --dry-run failed or produced no file list' });
    return 0;
  }

  const { manifest_sha256, files: sorted } = computeManifest(projectDir, files);
  fs.rmSync(dir, { recursive: true, force: true });
  emit({ cmd: 'manifest', repo, ref, name, version, files: sorted.slice(0, 60), manifest_sha256 });
  return 0;
}
