const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderPlist, runtimeLog } = require('./macos-dev-plist.cjs');

test('trust is exactly driver, packaged app, and resolved development runtime', () => {
  const text = renderPlist('/dev/repo/Electron.app/Contents/MacOS/Electron');
  assert.match(text, /<string>\/usr\/local\/tunnex:\/Applications\/Tunnex.app\/Contents\/MacOS:\/dev\/repo\/Electron.app\/Contents\/MacOS<\/string>/);
  assert.ok(text.includes(`<key>StandardErrorPath</key><string>${runtimeLog}</string>`));
  assert.equal(runtimeLog, '/var/run/tunnex/helper.log');
});
test('XML special characters cannot inject plist fields', () => {
  const text = renderPlist('/dev/a & <b> "c"/Electron');
  assert.ok(text.includes('/dev/a &amp; &lt;b&gt; &quot;c&quot;'));
});
test('relative paths and trust-list delimiter injection fail closed', () => {
  for (const value of ['Electron', '/dev/a:/evil/Electron', '/dev/a\n/Electron', '/dev/a\r/Electron', '/dev/a\0/Electron']) {
    assert.throws(() => renderPlist(value));
  }
});
test('installer consumes generated plist and never authorizes from rejected logs', () => {
  const script = fs.readFileSync(`${__dirname}/macos-dev-install.sh`, 'utf8');
  assert.doesNotMatch(script, /rejected_dir|REJDIR|caller exe|LOG=\/tmp\//);
  assert.ok(script.includes('sudo cp "$BUILD_DIR/helper.plist" "$PLIST"'));
  assert.ok(script.includes('chmod 600 /var/run/tunnex/helper.log'));
});
