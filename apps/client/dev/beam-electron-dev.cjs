// Persistent real desktop development using a separate profile. No credential seeding.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app } = require("electron");
const profile =
  process.env.TUNNEX_DEV_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), "tunnex-beam-dev-"));
if (!path.isAbsolute(profile))
  throw new Error("Development profile must be absolute");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath("userData", profile);
app.setAppLogsPath(path.join(profile, "logs"));
const cp = process.env.BEAM_TEST_CP_URL || "http://127.0.0.1:18283";
const url = new URL(cp);
if (
  !["http:", "https:"].includes(url.protocol) ||
  !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
)
  throw new Error("Development control plane must be a loopback base URL");
const configFile = path.join(profile, "tunnex.json");
if (!fs.existsSync(configFile))
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      serverUrl: url.origin,
      importedProfileId: "",
      managedOrganizationSelections: {},
    }),
    { mode: 0o600 },
  );
process.env.TUNNEX_BUNDLE_DIR = path.resolve(__dirname, "../../web/dist");
console.log(
  JSON.stringify({
    mode: "actual desktop development",
    profile,
    server: url.origin,
    bundle: process.env.TUNNEX_BUNDLE_DIR,
    pid: process.pid,
  }),
);
require("electron-log").transports.file.resolvePathFn = () =>
  path.join(profile, "logs", "main.log");
require("../dist/main/index.js");
