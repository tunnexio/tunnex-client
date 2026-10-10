const fs = require('node:fs');
const path = require('node:path');

// No dependency install required: reject invalid release tags before packaging.
function validateVersion(appVersion, workspaceVersion, ref = '') {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
  if (!semver.test(appVersion)) throw new Error(`Invalid app version: ${appVersion}. Use SemVer without build metadata.`);
  if (workspaceVersion !== appVersion) throw new Error(`Workspace version ${workspaceVersion} must match app version ${appVersion}.`);
  if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${appVersion}`) {
    throw new Error(`Tag ${ref.slice(10)} does not match committed app version ${appVersion}. Prepare and merge the version bump before creating its matching tag; do not move existing tags.`);
  }
  return appVersion;
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const readVersion = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version;
    const version = validateVersion(readVersion('apps/client/package.json'), readVersion('package.json'), process.env.GITHUB_REF);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    console.log(`Release version validated: ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { validateVersion };
