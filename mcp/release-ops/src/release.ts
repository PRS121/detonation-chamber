import { readFileAt, type GitHub, type Section } from './github.ts';

export type Pin = { section: Section; name: string; spec: string };

export async function commitReleasePrep(
  gh: GitHub,
  input: { repo: string; base_sha: string; version: string; pins: Pin[]; changelog_md: string; message: string },
) {
  const { octokit, org } = gh;
  const { repo } = input;
  const { data: meta } = await octokit.repos.get({ owner: org, repo });
  const branch = meta.default_branch;
  const { data: head } = await octokit.repos.getBranch({ owner: org, repo, branch });
  const baseSha = head.commit.sha;
  if (!baseSha.startsWith(input.base_sha.toLowerCase())) {
    throw new Error(`${branch} moved since the release was prepared (now at ${baseSha.slice(0, 7)}). Start the release again.`);
  }

  const pkgText = await readFileAt(gh, repo, 'package.json', baseSha);
  if (pkgText === null) throw new Error(`package.json not found in ${repo} at ${baseSha.slice(0, 7)}`);
  const pkg = JSON.parse(pkgText) as Record<string, unknown>;
  pkg.version = input.version;
  for (const pin of input.pins) {
    pkg[pin.section] = { ...((pkg[pin.section] as Record<string, string> | undefined) ?? {}), [pin.name]: pin.spec };
  }
  const indent = /^([ \t]+)"/m.exec(pkgText)?.[1] ?? '  ';

  const entry = input.changelog_md.trim() + '\n';
  const changelog = await readFileAt(gh, repo, 'CHANGELOG.md', baseSha);
  const heading = changelog === null ? null : /^# .*\n+/.exec(changelog);
  const newChangelog =
    changelog === null ? `# Changelog\n\n${entry}`
    : heading ? `${heading[0]}${entry}\n${changelog.slice(heading[0].length)}`
    : `${entry}\n${changelog}`;

  // Git Data API so package.json and CHANGELOG.md land in one commit.
  const { data: baseCommit } = await octokit.git.getCommit({ owner: org, repo, commit_sha: baseSha });
  const { data: tree } = await octokit.git.createTree({
    owner: org,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: [
      { path: 'package.json', mode: '100644', type: 'blob', content: JSON.stringify(pkg, null, indent) + '\n' },
      { path: 'CHANGELOG.md', mode: '100644', type: 'blob', content: newChangelog },
    ],
  });
  const { data: commit } = await octokit.git.createCommit({ owner: org, repo, message: input.message, tree: tree.sha, parents: [baseSha] });
  try {
    await octokit.git.updateRef({ owner: org, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  } catch (e) {
    if ((e as { status?: number }).status === 422) throw new Error(`${branch} moved while committing. Start the release again.`);
    throw e;
  }
  return { commit_sha: commit.sha, url: commit.html_url };
}

export async function createRelease(
  gh: GitHub,
  input: { repo: string; tag: string; target_sha: string; title: string; notes_md: string },
) {
  const { octokit, org } = gh;
  const version = input.tag.slice(1);
  const pkgText = await readFileAt(gh, input.repo, 'package.json', input.target_sha);
  if (pkgText === null) throw new Error(`package.json not found in ${input.repo} at ${input.target_sha.slice(0, 7)}`);
  const pkgVersion = (JSON.parse(pkgText) as { version?: string }).version;
  if (pkgVersion !== version) {
    throw new Error(`package.json at ${input.target_sha.slice(0, 7)} says ${pkgVersion}, not ${version}. Run commit_release_prep first.`);
  }
  const { data } = await octokit.repos.createRelease({
    owner: org,
    repo: input.repo,
    tag_name: input.tag,
    target_commitish: input.target_sha,
    name: input.title,
    body: input.notes_md,
    draft: false,
    prerelease: false,
  });
  return { tag: data.tag_name, release_url: data.html_url };
}
