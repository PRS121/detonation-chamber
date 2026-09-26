import { readFile } from 'node:fs/promises';
import { serialization, TrueForge, TrueForgeError } from '@truefoundry/trueforge-sdk';

const AGENT_NAME = 'release-captain';
const DESCRIPTION = 'Ships npm releases and detonates every changed dependency in a sealed sandbox room before the tests run.';

type RawSpec = { model: { name: string }; instructions: string };

// process.exit() while fetch sockets close crashes libuv on Windows, so failures unwind to main() instead.
class Stop extends Error {}
function fail(message: string): never {
  console.error(message);
  throw new Stop(message);
}

function substitute(text: string, file: string): string {
  const missing = new Set<string>();
  const result = text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = process.env[name]?.trim();
    if (!value || value.includes('<')) missing.add(name);
    return value ?? '';
  });
  if (missing.size) fail(`${file} needs ${[...missing].join(', ')}: set ${missing.size > 1 ? 'them' : 'it'} in .env`);
  return result;
}

async function main() {
  const baseUrl = process.env.TRUEFORGE_BASE_URL?.trim() || 'http://localhost:8790';
  const spec = JSON.parse(await readFile(new URL('./agent-spec.json', import.meta.url), 'utf8')) as RawSpec;
  spec.model.name = substitute(spec.model.name, 'agent-spec.json');
  spec.instructions = substitute(await readFile(new URL('./instructions.md', import.meta.url), 'utf8'), 'instructions.md');

  let manifest: ReturnType<typeof serialization.AgentSpec.parseOrThrow>;
  try {
    manifest = serialization.AgentSpec.parseOrThrow(spec, { unrecognizedObjectKeys: 'fail' });
  } catch (e) {
    fail(`agent/agent-spec.json does not match TrueForge's agent schema: ${(e as Error).message}`);
  }

  const client = new TrueForge({ baseUrl });
  try {
    const [connectors, skills] = await Promise.all([client.settings.mcpServers.list(), client.settings.skills.list()]);
    const connectorNames = new Set(connectors.data.map((c) => c.name));
    const missingConnectors = (manifest.mcpServers ?? []).map((s) => s.name).filter((n) => !connectorNames.has(n));
    if (missingConnectors.length) {
      fail(`Register the connector "${missingConnectors.join('", "')}" in TrueForge (Settings → Connectors) first, then run this again.`);
    }
    const skillNames = new Set(skills.data.map((s) => s.name));
    const missingSkills = (manifest.skills ?? []).map((s) => s.name).filter((n) => !skillNames.has(n));
    if (missingSkills.length) {
      console.warn(`Skill "${missingSkills.join('", "')}" is not registered in TrueForge yet: syncing without it. Run this again after registering it.`);
      manifest.skills = manifest.skills?.filter((s) => skillNames.has(s.name));
    }

    const page = await client.agents.list({ agentName: AGENT_NAME });
    const existing = page.data.find((a) => a.name === AGENT_NAME);
    const { data: agent } = existing
      ? await client.agents.update(existing.id, { description: DESCRIPTION, manifest })
      : await client.agents.create({ name: AGENT_NAME, description: DESCRIPTION, manifest });
    console.log(`${existing ? 'Updated' : 'Created'} agent "${agent.name}" (${agent.id}) using model ${spec.model.name}.`);
  } catch (e) {
    if (e instanceof Stop) throw e;
    if (e instanceof TrueForgeError) fail(`TrueForge refused (${e.statusCode ?? 'no status'}): ${JSON.stringify(e.body ?? e.message).slice(0, 500)}`);
    if ((e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') fail(`TrueForge is not running at ${baseUrl}.`);
    throw e;
  }
}

main().catch((e) => {
  if (!(e instanceof Stop)) console.error(e);
  process.exitCode = 1;
});
