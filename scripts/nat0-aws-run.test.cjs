// Offline configuration regression: never contacts AWS or starts a fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = readFileSync(`${__dirname}/nat0-aws-run.sh`, 'utf8');
const config = source.slice(source.indexOf('mode=${1:-tcp}'), source.indexOf('ssh_opts='));
for (const [mode, expected] of [
  ['tcp', 'turn:localhost:3478?transport=tcp|turn:192.0.2.10:13478?transport=tcp'],
  ['tls', 'turns:localhost:5349?transport=tcp|turns:192.0.2.10:15349?transport=tcp'],
]) {
  test(`AWS ${mode} selects matching server and diagnostic client transports`, () => {
    const mock = `
aws() {
  case "$*" in
    *get-caller-identity*) echo 735391218823;;
    *PublicIpAddress*) echo 192.0.2.10;;
    *Tags*) echo tunnex-nat0-aws-20260906a;;
    *) return 99;;
  esac
}
NAT_SSH_KEY=unused NAT_KNOWN_HOSTS=unused
`;
    const result = spawnSync('bash', ['-euc', mock + config + '\nprintf "%s|%s" "$remote_url" "$client_url"', 'test', mode], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.match(source, /NAT_PROOF_ICE_ONLY=yes[^\n]*TURN_URL="\$client_url"/);
  });
}
