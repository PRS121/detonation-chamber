// demo/seed.ts — reset tiny-slugify to its last published tag and lay down one round's 4 commits.
// Host-side, run by `npm run demo:seed` (tsx). Everything goes through the GitHub Git Data API so it
// works the same on Windows and Linux with no local clone and no git credential dance.
//
// Round shape (SPEC §8): fix (real) → feat (real) → bump a real dependency → bump the color-helper
// fixture to v1.2.4. The chamber then detonates the two changed deps; color-helper comes back BLOCKED.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Octokit } from '@octokit/rest';

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v && !v.includes('<') ? v : undefined;
};
const required = (name: string) => {
  const v = env(name);
  if (!v) {
    console.error(`[seed] ${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
};

const ORG = required('GH_ORG');
const REPO = env('DEMO_REPO') ?? 'tiny-slugify';
const FIXTURE = env('FIXTURE_REPO') ?? 'color-helper';
const SCOPE = required('NPM_SCOPE').replace(/^@/, '');
const TOKEN = required('GITHUB_TOKEN');
const PKG = `@${SCOPE}/${REPO}`;
const BASELINE = '1.3.0'; // the version everything resets to; rounds count from here

const octokit = new Octokit({ auth: TOKEN, userAgent: 'detonation-chamber-seed' });
const log = (msg: string) => console.error(`[seed] ${msg}`);

const ROUNDS_DIR = fileURLToPath(new URL('./rounds', import.meta.url));

type RoundCommit = { message: string; dir?: string; bump?: { section: string; name: string; to: string } };
type Round = { description?: string; commits: RoundCommit[] };

function parseSemver(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** latest published version + how many versions were published after the baseline (→ round index). */
async function registryState(): Promise<{ latest: string; publishedAfterBaseline: number }> {
  const res = await fetch(`https://registry.npmjs.org/${PKG.replace('/', '%2f')}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    log(`${PKG} is not on npm yet; using baseline v${BASELINE}.`);
    return { latest: BASELINE, publishedAfterBaseline: 0 };
  }
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${PKG}`);
  const doc = (await res.json()) as { 'dist-tags'?: { latest?: string }; versions?: Record<string, unknown> };
  const latest = doc['dist-tags']?.latest ?? BASELINE;
  const base = parseSemver(BASELINE)!;
  const after = Object.keys(doc.versions ?? {}).filter((v) => {
    const p = parseSemver(v);
    return p && cmp(p, base) > 0;
  }).length;
  return { latest, publishedAfterBaseline: after };
}

/** the commit sha a tag points at (dereferencing annotated tags). */
async function commitOfTag(tag: string): Promise<string> {
  const { data: ref } = await octokit.git.getRef({ owner: ORG, repo: REPO, ref: `tags/${tag}` });
  if (ref.object.type === 'tag') {
    const { data: t } = await octokit.git.getTag({ owner: ORG, repo: REPO, tag_sha: ref.object.sha });
    return t.object.sha;
  }
  return ref.object.sha;
}

/** delete every release tag strictly greater than the baseline (leftover rehearsals). */
async function deleteTagsAfterBaseline() {
  const base = parseSemver(BASELINE)!;
  const tags = await octokit.paginate(octokit.repos.listTags, { owner: ORG, repo: REPO, per_page: 100 });
  for (const t of tags) {
    const p = parseSemver(t.name);
    if (!p || cmp(p, base) <= 0) continue;
    try {
      const { data: rel } = await octokit.repos.getReleaseByTag({ owner: ORG, repo: REPO, tag: t.name });
      await octokit.repos.deleteRelease({ owner: ORG, repo: REPO, release_id: rel.id });
      log(`deleted release ${t.name}`);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    await octokit.git.deleteRef({ owner: ORG, repo: REPO, ref: `tags/${t.name}` });
    log(`deleted tag ${t.name}`);
  }
}

/** all files under dir → tree entries with inline utf8 content, paths relative to dir. */
function treeEntriesFromDir(dir: string): { path: string; mode: '100644'; type: 'blob'; content: string }[] {
  const out: { path: string; mode: '100644'; type: 'blob'; content: string }[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else out.push({ path: childRel, mode: '100644', type: 'blob', content: readFileSync(childAbs, 'utf8') });
    }
  };
  walk(dir, '');
  return out;
}

async function readPackageJson(commitSha: string): Promise<{ text: string; json: Record<string, unknown> }> {
  const { data } = await octokit.repos.getContent({ owner: ORG, repo: REPO, path: 'package.json', ref: commitSha });
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) throw new Error('package.json is not a file');
  const text = Buffer.from(data.content, 'base64').toString('utf8');
  return { text, json: JSON.parse(text) };
}

/** create one commit on top of parentSha and return the new commit sha (does not move any branch). */
async function makeCommit(
  parentSha: string,
  message: string,
  entries: { path: string; mode: '100644'; type: 'blob'; content: string }[],
): Promise<string> {
  const { data: parent } = await octokit.git.getCommit({ owner: ORG, repo: REPO, commit_sha: parentSha });
  const { data: tree } = await octokit.git.createTree({ owner: ORG, repo: REPO, base_tree: parent.tree.sha, tree: entries });
  const { data: commit } = await octokit.git.createCommit({ owner: ORG, repo: REPO, message, tree: tree.sha, parents: [parentSha] });
  return commit.sha;
}

async function main() {
  const roundDirs = readdirSync(ROUNDS_DIR)
    .filter((d) => statSync(path.join(ROUNDS_DIR, d)).isDirectory())
    .sort();
  if (roundDirs.length === 0) throw new Error(`no rounds under ${ROUNDS_DIR}`);

  const { latest, publishedAfterBaseline } = await registryState();
  const baseTag = `v${latest}`;
  const roundName = roundDirs[publishedAfterBaseline % roundDirs.length];
  const round = JSON.parse(readFileSync(path.join(ROUNDS_DIR, roundName, 'round.json'), 'utf8')) as Round;
  log(`base tag ${baseTag}; applying round "${roundName}" (${round.description ?? ''})`);

  // 1. reset main to the baseline commit
  const baseSha = await commitOfTag(baseTag);
  await octokit.git.updateRef({ owner: ORG, repo: REPO, ref: 'heads/main', sha: baseSha, force: true });
  log(`main reset to ${baseTag} (${baseSha.slice(0, 7)})`);

  // 2. clear rehearsal tags/releases above the baseline
  await deleteTagsAfterBaseline();

  // 3. lay down the round's commits, chaining each on the previous
  let head = baseSha;
  const created: { message: string; sha: string }[] = [];
  for (const c of round.commits) {
    let entries: { path: string; mode: '100644'; type: 'blob'; content: string }[];
    if (c.dir) {
      entries = treeEntriesFromDir(path.join(ROUNDS_DIR, roundName, c.dir));
    } else if (c.bump) {
      const { json } = await readPackageJson(head);
      const spec = c.bump.name === `@quarantine-lab/${FIXTURE}` ? c.bump.to.replace('$ORG', ORG) : c.bump.to;
      const section = (json[c.bump.section] as Record<string, string> | undefined) ?? {};
      json[c.bump.section] = { ...section, [c.bump.name]: spec };
      entries = [{ path: 'package.json', mode: '100644', type: 'blob', content: JSON.stringify(json, null, 2) + '\n' }];
    } else {
      throw new Error(`round commit "${c.message}" has neither dir nor bump`);
    }
    head = await makeCommit(head, c.message, entries);
    created.push({ message: c.message.split('\n')[0], sha: head });
  }

  await octokit.git.updateRef({ owner: ORG, repo: REPO, ref: 'heads/main', sha: head, force: true });

  log('done. commits on main:');
  for (const c of created) console.error(`  ${c.sha.slice(0, 7)}  ${c.message}`);
  console.log(JSON.stringify({ repo: REPO, base_tag: baseTag, round: roundName, head_sha: head, commits: created.map((c) => c.sha.slice(0, 7)) }));
}

main().catch((e) => {
  log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
