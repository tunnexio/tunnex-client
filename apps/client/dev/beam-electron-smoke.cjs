// Real Electron main/preload/renderer qualification in a fresh, task-owned profile.
// No fixture token or private key is injected into production startup.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow } = require("electron");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tunnex-beam-electron-"));
app.setPath("userData", profile);
app.setAppLogsPath(path.join(profile, "logs"));
fs.writeFileSync(
  path.join(profile, "tunnex.json"),
  JSON.stringify({
    serverUrl: process.env.BEAM_TEST_CP_URL || "http://127.0.0.1:18283",
    importedProfileId: "",
    managedOrganizationSelections: {},
  }),
  { mode: 0o600 },
);
process.env.TUNNEX_BUNDLE_DIR = path.resolve(__dirname, "../../web/dist");
app.whenReady().then(async () => {
  try {
    await new Promise((resolve) =>
      app.once("browser-window-created", (_event, win) =>
        win.webContents.once("did-finish-load", resolve),
      ),
    );
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.focus();
    app.focus({ steal: true });
    const result = await win.webContents.executeJavaScript(`(async()=>{
    const bridge=window.tunnex;
    if(!bridge?.beam)throw new Error('Beam preload missing');
    const exposed=Object.keys(bridge.beam);
    if(exposed.some(k=>/^(?:getToken|token|credential|key|bootstrap|invoke)$/i.test(k)))throw new Error('Secret/generic verb exposed');
    let refused=false;try{await bridge.beam.view();}catch{refused=true;}
    if(!refused)throw new Error('Fresh profile gained publishing authority');
    document.querySelector('[aria-label="Open navigation"]').click();
    await new Promise(resolve=>setTimeout(resolve,50));
    document.querySelector('[data-pane="beam"]').click();
    await new Promise(resolve=>setTimeout(resolve,150));
    if(!document.querySelector('[aria-label="Tunnex Beam"]'))throw new Error('Beam product UI absent');
    return {exposed,refused,ui:document.querySelector('[aria-label="Tunnex Beam"]').innerText};
  })()`);
    const prefs = win.webContents.getLastWebPreferences();
    if (!prefs.contextIsolation || prefs.nodeIntegration || !prefs.sandbox)
      throw new Error("Renderer privilege boundary changed");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const shot = await win.webContents.capturePage();
    const screenshot = path.join(profile, "beam-desktop.png");
    fs.writeFileSync(screenshot, shot.toPNG());
    console.log(
      JSON.stringify(
        {
          proof: "actual Electron main/preload/renderer",
          electron: process.versions.electron,
          node: process.versions.node,
          profile,
          screenshot,
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          result,
        },
        null,
        2,
      ),
    );
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
setTimeout(() => {
  console.error("Electron smoke timed out");
  app.exit(1);
}, 30000).unref();
require("electron-log").transports.file.resolvePathFn = () =>
  path.join(profile, "logs", "main.log");
require("../dist/main/index.js");
