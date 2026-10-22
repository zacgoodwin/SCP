import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseTagError } from '../../scripts/release-tag.mts';

test('release tag must be v + semver VERSION', () => {
  assert.equal(releaseTagError('v0.1.0', '0.1.0\n'), null);
  assert.equal(releaseTagError('v0.1.0', '0.1.0\r\n'), null);
  assert.equal(releaseTagError('v1.0.0-rc.1', '1.0.0-rc.1'), null);
  assert.match(releaseTagError('v0.1.1', '0.1.0') ?? '', /does not match/);
  assert.match(releaseTagError('0.1.0', '0.1.0') ?? '', /does not match/);
  assert.match(releaseTagError('v0.2', '0.2') ?? '', /not semver/);
  assert.match(releaseTagError('v1.2.3beta', '1.2.3 beta') ?? '', /not semver/);
  assert.match(releaseTagError('v', '') ?? '', /not semver/);
  assert.equal(releaseTagError('v1.0.0-alpha.0.x-1', '1.0.0-alpha.0.x-1'), null);
  for (const v of ['01.0.0', '1.00.0', '1.0.0-01', '1.0.0-rc..1', '1.0.0-', '1.0.0+build']) {
    assert.match(releaseTagError(`v${v}`, v) ?? '', /not semver/, v);
  }
});
