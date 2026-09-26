import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { getDependencyChanges, getReleaseContext, SECTIONS, type GitHub } from './github.ts';
import { getPackageIntel } from './npm.ts';
import { publishPackage, type PublishMode } from './publish.ts';
import { commitReleasePrep, createRelease } from './release.ts';

const log = (msg: string) => console.error(`[release-ops ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const env = (name: string) => process.env[name]?.trim() || undefined;
function required(name: string): string {
  const value = env(name);
  if (!value) {
    log(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const PORT = Number(env('MCP_PORT') ?? 8787);
const SECRET = required('MCP_SHARED_SECRET');
if (SECRET.length < 16 || SECRET.startsWith('<')) {
  log('MCP_SHARED_SECRET must be a real random string of at least 16 characters.');
  process.exit(1);
}
const ORG = required('GH_ORG');
const GITHUB_TOKEN = env('GITHUB_TOKEN');
if (!GITHUB_TOKEN) log('GITHUB_TOKEN is not set: GitHub reads are anonymous (60 requests/hour) and writes will fail.');
const PUBLISH_MODE = (env('PUBLISH_MODE') ?? 'dry-run') as PublishMode;
if (PUBLISH_MODE !== 'dry-run' && PUBLISH_MODE !== 'live') {
  log('PUBLISH_MODE must be "dry-run" or "live".');
  process.exit(1);
}
const publishConfig = { mode: PUBLISH_MODE, npmToken: env('NPM_TOKEN'), npmScope: env('NPM_SCOPE')?.replace(/^@/, '') };

const gh: GitHub = { octokit: new Octokit({ auth: GITHUB_TOKEN, userAgent: 'detonation-chamber-release-ops' }), org: ORG };
const secretDigest = createHash('sha256').update(SECRET).digest();

const repoName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).describe(`Repository name inside the ${ORG} GitHub org, e.g. tiny-slugify`);
const gitRef = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).describe('Tag, branch or commit SHA');
const npmName = z.string().max(214).regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/).describe('npm package name');
const versionSpec = z.string().min(1).max(100);
const sha = z.string().regex(/^[0-9a-fA-F]{7,40}$/).describe('Commit SHA');
const releaseTag = z.string().regex(/^v\d+\.\d+\.\d+$/).describe('Release tag, e.g. v1.4.0');
const markdown = z.string().min(1).max(20_000);

function errorText(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  if (status === 401) return 'GitHub rejected the token (401). Check GITHUB_TOKEN.';
  if (status === 403 || status === 429) return `GitHub refused the request (${status}): missing permission or rate limit.`;
  if (status === 404) return `Not found on GitHub: check the repo name and ref. (${message})`;
  if (status === 409 || status === 422) return `GitHub rejected the change (${status}): ${message}`;
  return message;
}

async function run(name: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
    const result = await fn();
    log(`${name} ok in ${Date.now() - started} ms`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    const text = errorText(e);
    log(`${name} failed in ${Date.now() - started} ms: ${text}`);
    return { isError: true, content: [{ type: 'text' as const, text }] };
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'release-ops', version: '0.1.0' });

  server.registerTool(
    'get_release_context',
    {
      title: 'Get release context',
      description:
        'For a repo in our GitHub org: the last release tag (vX.Y.Z reachable from the default branch), the commits since it, ' +
        'HEAD sha, clone URL, and the next version suggested by conventional commits (BREAKING → major, feat → minor, else patch).',
      inputSchema: { repo: repoName },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repo }) => run('get_release_context', () => getReleaseContext(gh, repo)),
  );

  server.registerTool(
    'get_dependency_changes',
    {
      title: 'Get dependency changes',
      description:
        'Compares package.json between two refs (usually last_tag_sha and head_sha) and lists every dependency whose spec changed. ' +
        'from=null means added, to=null means removed. kind is "npm" for registry packages and "git" for git dependencies.',
      inputSchema: { repo: repoName, base: gitRef, head: gitRef },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repo, base, head }) => run('get_dependency_changes', () => getDependencyChanges(gh, repo, base, head)),
  );

  server.registerTool(
    'get_package_intel',
    {
      title: 'Get npm package intel',
      description:
        'npm registry facts about one dependency bump (kind "npm" only): when the new version was published and its age in hours, ' +
        'the publisher, whether maintainers changed, provenance, deprecation, and versions that were pulled from npm between from and to.',
      inputSchema: {
        name: npmName,
        from: versionSpec.nullable().optional().describe('Old version or ^/~ range; null if the dependency is new'),
        to: versionSpec.describe('New version or ^/~ range'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ name, from, to }) => run('get_package_intel', () => getPackageIntel(name, from ?? null, to)),
  );

  server.registerTool(
    'commit_release_prep',
    {
      title: 'Commit release prep',
      description:
        'Pushes ONE commit to the default branch that sets package.json "version", applies dependency pins and prepends ' +
        'the release notes to CHANGELOG.md. Refuses if the branch moved past base_sha. Never runs npm. Returns the new commit sha.',
      inputSchema: {
        repo: repoName,
        base_sha: sha.describe('head_sha from get_release_context; the commit must still be the branch head'),
        version: z.string().regex(/^\d+\.\d+\.\d+$/).describe('New version without "v", e.g. 1.4.0'),
        pins: z
          .array(z.object({ section: z.enum(SECTIONS), name: npmName, spec: versionSpec.max(200) }))
          .max(20)
          .describe('Dependency pins from heal reports; [] when nothing was healed'),
        changelog_md: markdown.describe('Release notes to prepend to CHANGELOG.md'),
        message: z.string().min(1).max(500).describe('Commit message, e.g. "chore(release): v1.4.0"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => run('commit_release_prep', () => commitReleasePrep(gh, input)),
  );

  server.registerTool(
    'create_release',
    {
      title: 'Create tag and GitHub release',
      description:
        'Creates the tag at target_sha and a GitHub release with the notes. Refuses unless package.json at target_sha ' +
        'already has the tag\'s version (run commit_release_prep first). Tags are permanent for the release history.',
      inputSchema: { repo: repoName, tag: releaseTag, target_sha: sha, title: z.string().min(1).max(200), notes_md: markdown },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (input) => run('create_release', () => createRelease(gh, input)),
  );

  server.registerTool(
    'publish_package',
    {
      title: 'Publish to npm',
      description:
        `Clean-clones the tag, checks package.json matches it, recomputes the manifest of every packed file and refuses if it ` +
        `differs from expected_manifest_sha256, then publishes with install scripts off. Current mode: ${PUBLISH_MODE}. ` +
        'A live publish can never be undone and requires expected_manifest_sha256.',
      inputSchema: {
        repo: repoName,
        tag: releaseTag,
        expected_manifest_sha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe('manifest_sha256 from the chamber manifest command on the release commit'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (input) => run('publish_package', () => publishPackage(gh, input, publishConfig)),
  );

  return server;
}

function authorized(req: IncomingMessage): boolean {
  const key = req.headers['x-release-ops-key'];
  if (typeof key !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(key).digest(), secretDigest);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/healthz') return sendJson(res, 200, { ok: true });
  if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' });
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
  // Stateless server: no sessions and no standalone SSE stream, so only POST is served.
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    log(`request failed: ${errorText(e)}`);
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

http.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/mcp for org ${ORG}, publish mode ${PUBLISH_MODE}`));
