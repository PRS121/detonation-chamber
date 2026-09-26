import type { Octokit } from '@octokit/rest';
import * as semver from './semver.ts';

export type GitHub = { octokit: Octokit; org: string };

type Commit = { sha7: string; subject: string; author: string; date: string };

const MAX_TAGS_TO_TRY = 5;

export async function getReleaseContext(gh: GitHub, repo: string) {
  const { octokit, org } = gh;
  const { data: meta } = await octokit.repos.get({ owner: org, repo });
  const { data: branch } = await octokit.repos.getBranch({ owner: org, repo, branch: meta.default_branch });
  const headSha = branch.commit.sha;

  const tags = (await octokit.paginate(octokit.repos.listTags, { owner: org, repo, per_page: 100 }))
    .map((t) => ({ name: t.name, sha: t.commit.sha, v: semver.parse(t.name) }))
    .filter((t): t is { name: string; sha: string; v: semver.SemVer } => t.v !== null && !t.v.pre)
    .sort((a, b) => semver.compare(b.v, a.v));

  // The highest release tag that is an ancestor of HEAD; rehearsal tags off main are skipped.
  let lastTag: (typeof tags)[number] | null = null;
  let messages: string[] = [];
  let commits: Commit[] = [];
  for (const tag of tags.slice(0, MAX_TAGS_TO_TRY)) {
    const { data } = await octokit.repos.compareCommitsWithBasehead({ owner: org, repo, basehead: `${tag.sha}...${headSha}` });
    if (data.status === 'ahead' || data.status === 'identical') {
      lastTag = tag;
      messages = data.commits.map((c) => c.commit.message);
      commits = data.commits.map(toCommit);
      break;
    }
  }
  if (!lastTag) {
    const { data } = await octokit.repos.listCommits({ owner: org, repo, sha: headSha, per_page: 50 });
    data.reverse();
    messages = data.map((c) => c.commit.message);
    commits = data.map(toCommit);
  }

  return {
    repo,
    clone_url: meta.clone_url,
    default_branch: meta.default_branch,
    last_tag: lastTag?.name ?? null,
    last_tag_sha: lastTag?.sha ?? null,
    head_sha: headSha,
    commits,
    suggested_next_version: commits.length ? nextVersion(lastTag ? semver.format(lastTag.v) : '0.0.0', messages) : null,
  };
}

function toCommit(c: { sha: string; commit: { message: string; author: { name?: string; date?: string } | null }; author: { login?: string } | null }): Commit {
  return {
    sha7: c.sha.slice(0, 7),
    subject: c.commit.message.split('\n')[0],
    author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
    date: c.commit.author?.date ?? '',
  };
}

function nextVersion(base: string, messages: string[]): string {
  let level: semver.BumpLevel = 'patch';
  for (const message of messages) {
    const subject = message.split('\n')[0];
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(message)) return semver.bump(base, 'major');
    if (/^feat(\([^)]*\))?:/.test(subject)) level = 'minor';
  }
  return semver.bump(base, level);
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
type PackageJson = Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>;

export async function getDependencyChanges(gh: GitHub, repo: string, base: string, head: string) {
  const [before, after] = await Promise.all([readPackageJson(gh, repo, base), readPackageJson(gh, repo, head)]);
  if (!after) throw new Error(`package.json not found in ${repo} at ${head}`);
  const changes: { name: string; section: string; from: string | null; to: string | null; kind: 'npm' | 'git' }[] = [];
  for (const section of SECTIONS) {
    const a = before?.[section] ?? {};
    const b = after[section] ?? {};
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const from = a[name] ?? null;
      const to = b[name] ?? null;
      if (from !== to) changes.push({ name, section, from, to, kind: kindOf((to ?? from)!) });
    }
  }
  return { changes };
}

async function readPackageJson(gh: GitHub, repo: string, ref: string): Promise<PackageJson | null> {
  try {
    const { data } = await gh.octokit.repos.getContent({ owner: gh.org, repo, path: 'package.json', ref });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) throw new Error(`package.json in ${repo} at ${ref} is not a file`);
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')) as PackageJson;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

function kindOf(spec: string): 'npm' | 'git' {
  if (/^(github:|gitlab:|bitbucket:|git\+|git:|git@)/.test(spec)) return 'git';
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec) || /\.git(#.*)?$/.test(spec)) return 'git';
  return 'npm';
}
