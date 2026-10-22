// Release guard for .github/workflows/release.yml: the pushed tag must be `v` + VERSION, and VERSION must
// be semver, or metadata-action's semver pattern emits no version tag and the image ships unversioned.
// Usage: node scripts/release-tag.mts <tag>   (reads ./VERSION, exits non-zero on mismatch)
import { readFileSync } from 'node:fs';

// semver.org grammar minus +build metadata (`+` is not a legal Docker tag character).
const NUM = '(?:0|[1-9]\\d*)';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?$`);

export function releaseTagError(tag: string, versionFile: string): string | null {
  const version = versionFile.trim();
  if (!SEMVER.test(version)) return `VERSION "${version}" is not semver (x.y.z or x.y.z-pre)`;
  if (tag !== `v${version}`) return `tag ${tag} does not match VERSION (v${version})`;
  return null;
}

if (import.meta.main) {
  const err = releaseTagError(process.argv[2] ?? '', readFileSync('VERSION', 'utf8'));
  if (err) {
    console.error(err);
    process.exit(1);
  }
}
