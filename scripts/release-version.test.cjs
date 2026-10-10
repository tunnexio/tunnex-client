const test = require('node:test');
const assert = require('node:assert/strict');
const { validateVersion } = require('./release-version.cjs');

test('branch and PR builds use the committed version', () => {
  for (const ref of ['', 'refs/heads/main', 'refs/pull/13/merge']) {
    assert.equal(validateVersion('0.1.7', '0.1.7', ref), '0.1.7');
  }
});
test('matching stable and prerelease tags are accepted', () => {
  for (const version of ['0.1.7', '1.0.0-rc.1']) {
    assert.equal(validateVersion(version, version, `refs/tags/v${version}`), version);
  }
});
test('the failed v0.1.6 release is rejected before builds', () => {
  assert.throws(() => validateVersion('0.1.5', '0.1.5', 'refs/tags/v0.1.6'), /does not match/);
});
test('workspace drift is rejected', () => {
  assert.throws(() => validateVersion('0.1.7', '0.1.5'), /Workspace version/);
});
test('malformed and metadata versions cannot reach packaging', () => {
  for (const version of ['01.1.7', '1.0', 'v1.0.0', '1.0.0-01', '1.0.0+build', '1.0.0-']) {
    assert.throws(() => validateVersion(version, version), /Invalid app version/);
  }
});
