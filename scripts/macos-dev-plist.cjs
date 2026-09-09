// No log, environment-supplied trust list, or rejected-caller input is accepted.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const runtimeLog = '/var/run/tunnex/helper.log';
function renderPlist(electronExecutable) {
  if (!path.posix.isAbsolute(electronExecutable) || /[:\r\n\0]/.test(electronExecutable)) {
    throw new Error('invalid Electron executable path');
  }
  const dirs = ['/usr/local/tunnex', '/Applications/Tunnex.app/Contents/MacOS', path.posix.dirname(electronExecutable)];
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.tunnex.helper</string>
  <key>ProgramArguments</key><array><string>/usr/local/tunnex/tunnex-helper</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>TUNNEX_INSTALL_DIR</key><string>${xml([...new Set(dirs)].join(':'))}</string>
    <key>TUNNEX_HELPER_SOCKET</key><string>/var/run/tunnex/helper.sock</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${runtimeLog}</string>
</dict></plist>
`;
}

if (require.main === module) {
  const clientRequire = createRequire(path.resolve(__dirname, '../apps/client/package.json'));
  const executable = fs.realpathSync(clientRequire('electron'));
  if (!fs.statSync(executable).isFile()) throw new Error('Electron executable missing');
  fs.accessSync(executable, fs.constants.X_OK);
  process.stdout.write(renderPlist(executable));
}
module.exports = { renderPlist, runtimeLog };
