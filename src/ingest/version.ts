// Tiny semver-ish range comparator (no external dep).
// Ranges: "^N" (major === N), ">=a <b" (a <= v < b), or undefined (any).

export type Version = [major: number, minor: number];

const NEG_INF: Version = [-Infinity, 0];
const POS_INF: Version = [Infinity, 0];

/** Parse a version string like "1.5", "2", or "v16" into a comparable [major, minor] tuple. */
export function parseVer(v: string): Version {
  const s = v.trim().replace(/^v/i, "");
  const parts = s.split(".");
  const major = Number(parts[0] ?? 0);
  const minor = Number(parts[1] ?? 0);
  return [Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0];
}

function cmpVer(a: Version, b: Version): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/** True if version `v` satisfies `range` ("^N" | ">=a <b" | undefined). */
export function satisfies(v: string, range: string | undefined): boolean {
  const ver = parseVer(v);
  if (range === undefined) return true;
  if (range.startsWith("^")) {
    const major = Number(range.slice(1).trim());
    return ver[0] === major;
  }
  // ">=a <b"
  const geMatch = range.match(/>=\s*([^\s<]+)/);
  const ltMatch = range.match(/<\s*([^\s]+)/);
  if (geMatch) {
    const lo = parseVer(geMatch[1]);
    if (cmpVer(ver, lo) < 0) return false;
  }
  if (ltMatch) {
    const hi = parseVer(ltMatch[1]);
    if (cmpVer(ver, hi) >= 0) return false;
  }
  return true;
}

/** Lower bound of a range for nearest-below/above ordering. -Infinity if unbounded. */
export function minOf(range: string | undefined): Version {
  if (range === undefined) return NEG_INF;
  if (range.startsWith("^")) {
    const major = Number(range.slice(1).trim());
    return [Number.isFinite(major) ? major : 0, 0];
  }
  const geMatch = range.match(/>=\s*([^\s<]+)/);
  if (geMatch) return parseVer(geMatch[1]);
  return NEG_INF;
}

/** Upper bound of a range. Infinity if unbounded. */
export function maxOf(range: string | undefined): Version {
  if (range === undefined) return POS_INF;
  if (range.startsWith("^")) return POS_INF;
  const ltMatch = range.match(/<\s*([^\s]+)/);
  if (ltMatch) return parseVer(ltMatch[1]);
  return POS_INF;
}

/** Compare two versions (range bounds) for sorting. */
export function compareVersions(a: Version, b: Version): number {
  return cmpVer(a, b);
}
