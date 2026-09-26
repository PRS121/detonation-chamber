export type SemVer = { major: number; minor: number; patch: number; pre: string };
export type BumpLevel = 'major' | 'minor' | 'patch';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(v: string): SemVer | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
}

export function compare(a: SemVer, b: SemVer): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d) return d;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function format(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bump(version: string, level: BumpLevel): string {
  const v = parse(version) ?? { major: 0, minor: 0, patch: 0, pre: '' };
  if (level === 'major') return format({ major: v.major + 1, minor: 0, patch: 0, pre: '' });
  if (level === 'minor') return format({ major: v.major, minor: v.minor + 1, patch: 0, pre: '' });
  return format({ major: v.major, minor: v.minor, patch: v.patch + 1, pre: '' });
}

/** Resolves an exact version, `^x.y.z` or `~x.y.z` against the published versions; null for anything else. */
export function resolve(spec: string, available: string[]): string | null {
  const s = spec.trim().replace(/^=/, '');
  const exact = parse(s);
  if (exact) return s.replace(/^v/, '');
  const op = s[0];
  const base = parse(s.slice(1));
  if ((op !== '^' && op !== '~') || !base) return null;
  const inRange = (v: SemVer) => {
    if (v.pre || compare(v, base) < 0) return false;
    if (op === '~') return v.major === base.major && v.minor === base.minor;
    if (base.major > 0) return v.major === base.major;
    return v.major === 0 && v.minor === base.minor;
  };
  let best: SemVer | null = null;
  for (const raw of available) {
    const v = parse(raw);
    if (v && inRange(v) && (!best || compare(v, best) > 0)) best = v;
  }
  return best ? format(best) : null;
}
