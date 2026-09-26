import { exec, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitHub } from './github.ts';

export type PublishMode = 'dry-run' | 'live';
export type PublishConfig = { mode: PublishMode; npmToken?: string; npmScope?: string };

type Manifest = { manifest_sha256: string };
type ComputeManifest = (dir: string, files: string[]) => Manifest | Promise<Manifest>;

const MANIFEST_MODULE = new URL('../../../skills/supply-chain-gate/lib/manifest.mjs', import.meta.url);
const SECRET_ENV = ['GITHUB_TOKEN', 'NPM_TOKEN', 'MCP_SHARED_SECRET'];
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function publishPackage(
  gh: GitHub,
  input: { repo: string; tag: string; expected_manifest_sha256?: string },
  config: PublishConfig,
) {
  const { mode } = config;
  const expected = input.expected_manifest_sha256?.toLowerCase();
  const dir = await mkdtemp(join(tmpdir(), 'release-ops-'));
  try {
    const src = join(dir, 'src');
    await run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', input.tag, `https://github.com/${gh.org}/${input.repo}.git`, src], dir);

    const pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8')) as { name: string; version: string };
    if (`v${pkg.version}` !== input.tag) throw new Error(`package.json at ${input.tag} says ${pkg.version}. Refusing to publish.`);
    if (config.npmScope && !pkg.name.startsWith(`@${config.npmScope}/`)) throw new Error(`${pkg.name} is outside our npm scope @${config.npmScope}. Refusing to publish.`);
    if (mode === 'live' && !config.npmScope) throw new Error('NPM_SCOPE is not set. Refusing to publish live.');

    const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], src)) as { files: { path: string }[] }[];
    const files = listing[0].files.map((f) => f.path);

    const computeManifest = await loadComputeManifest();
    const manifest = computeManifest ? (await computeManifest(src, files)).manifest_sha256.toLowerCase() : null;
    const matched = manifest && expected ? manifest === expected : null;
    if (matched === false) {
      throw new Error(`Manifest mismatch: tested ${expected!.slice(0, 12)}…, ${input.tag} packs ${manifest!.slice(0, 12)}…. Refusing to publish.`);
    }
    if (mode === 'live' && matched !== true) {
      throw new Error('A live publish needs a matching manifest: pass expected_manifest_sha256 and make sure skills/supply-chain-gate/lib/manifest.mjs exists.');
    }

    const packed = JSON.parse(await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], src)) as { filename: string }[];
    const tarball = join(dir, packed[0].filename);
    if (mode === 'live') {
      if (!config.npmToken) throw new Error('NPM_TOKEN is not set. Refusing to publish live.');
      const npmrc = join(dir, 'publish.npmrc');
      await writeFile(npmrc, `//registry.npmjs.org/:_authToken=${config.npmToken}\n`, { mode: 0o600 });
      await run('npm', ['publish', tarball, '--access', 'public', '--ignore-scripts', '--userconfig', npmrc], dir, config.npmToken);
    } else {
      await run('npm', ['publish', tarball, '--dry-run', '--ignore-scripts'], dir);
    }

    return {
      mode,
      name: pkg.name,
      version: pkg.version,
      npm_url: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      manifest_sha256: manifest,
      matched,
      ...(matched === null && { note: computeManifest ? 'No expected_manifest_sha256 given: manifest not compared.' : 'manifest.mjs not available yet: manifest not checked.' }),
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function loadComputeManifest(): Promise<ComputeManifest | null> {
  try {
    const mod = (await import(MANIFEST_MODULE.href)) as { computeManifest?: ComputeManifest };
    return typeof mod.computeManifest === 'function' ? mod.computeManifest : null;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}

/** npm runs through a shell (npm.cmd on Windows), so its arguments are quoted; git runs without a shell. */
async function run(cmd: 'git' | 'npm', args: string[], cwd: string, secret?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const key of SECRET_ENV) delete env[key];
  const options = { cwd, env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' as const };
  try {
    const { stdout } = cmd === 'npm'
      ? await execAsync(['npm', ...args.map(quote)].join(' '), options)
      : await execFileAsync(cmd, args, options);
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; code?: number | string };
    const lines = (err.stderr || err.stdout || String(e)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const errorLines = lines.filter((l) => /^(npm (error|ERR!)|fatal:|error:)/.test(l) && !/complete log/i.test(l));
    let detail = (errorLines.length ? errorLines : lines).join(' ');
    if (secret) detail = detail.split(secret).join('***');
    const subcommand = args.find((a) => /^[a-z]+$/.test(a)) ?? '';
    throw new Error(`${cmd} ${subcommand} failed (${err.code ?? 'error'}): ${detail.slice(-300)}`);
  }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}
