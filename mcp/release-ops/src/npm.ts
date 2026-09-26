import * as semver from './semver.ts';

const REGISTRY = 'https://registry.npmjs.org/';

type VersionMeta = {
  maintainers?: { name: string }[];
  _npmUser?: { name: string };
  deprecated?: string;
  dist?: { attestations?: unknown };
};
type Packument = { versions?: Record<string, VersionMeta>; time?: Record<string, string> };

export async function getPackageIntel(name: string, from: string | null, to: string) {
  const res = await fetch(REGISTRY + name.replace('/', '%2f'), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error(`${name} is not on the npm registry`);
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}`);
  const doc = (await res.json()) as Packument;
  const versions = doc.versions ?? {};
  const time = doc.time ?? {};
  const available = Object.keys(versions);

  const toV = semver.resolve(to, available);
  if (!toV) throw new Error(`cannot resolve "${to}" for ${name}; pass an exact version or a ^/~ range`);
  const fromV = from ? semver.resolve(from, available) : null;
  if (from && !fromV) throw new Error(`cannot resolve "${from}" for ${name}; pass an exact version or a ^/~ range`);

  const toMeta = versions[toV];
  const fromMeta = fromV ? versions[fromV] : undefined;
  const publishedAt = time[toV] ?? null;
  const publisher = toMeta?._npmUser?.name ?? null;
  const names = (m?: VersionMeta) => (m?.maintainers ?? []).map((x) => x.name).sort();
  const maintainersChanged = fromMeta
    ? names(fromMeta).join() !== names(toMeta).join() || (publisher !== null && !names(fromMeta).includes(publisher))
    : false;

  return {
    name,
    from: fromV,
    to: toV,
    to_published_at: publishedAt,
    age_hours: publishedAt ? Math.round(((Date.now() - Date.parse(publishedAt)) / 3_600_000) * 10) / 10 : null,
    publisher,
    maintainers_changed: maintainersChanged,
    has_provenance: Boolean(toMeta?.dist?.attestations),
    deprecated: toMeta?.deprecated ?? false,
    removed_versions_in_range: fromV ? removedBetween(fromV, toV, versions, time) : [],
  };
}

/** Versions in the registry's `time` map but missing from `versions`, strictly between the two bounds. */
function removedBetween(a: string, b: string, versions: Record<string, VersionMeta>, time: Record<string, string>) {
  const pa = semver.parse(a);
  const pb = semver.parse(b);
  if (!pa || !pb) return [];
  const [lo, hi] = semver.compare(pa, pb) <= 0 ? [pa, pb] : [pb, pa];
  return Object.keys(time)
    .filter((v) => v !== 'created' && v !== 'modified' && !(v in versions))
    .map((v) => ({ v, parsed: semver.parse(v) }))
    .filter((x): x is { v: string; parsed: semver.SemVer } => x.parsed !== null && semver.compare(lo, x.parsed) < 0 && semver.compare(x.parsed, hi) < 0)
    .sort((x, y) => semver.compare(x.parsed, y.parsed))
    .map((x) => ({ version: x.v, published_at: time[x.v] }));
}
