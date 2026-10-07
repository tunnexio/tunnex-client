// Explicit local CP qualification. No credential/token seeding: production
// auth.login owns PKCE, the callback, exchange and encrypted credential storage.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const assert = require("node:assert/strict");
const { app, BrowserWindow, shell, clipboard } = require("electron");
const cp = new URL(process.env.BEAM_TEST_CP_URL || "http://127.0.0.1:18283");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(cp.hostname) ||
  !["http:", "https:"].includes(cp.protocol) ||
  cp.username ||
  cp.password ||
  cp.pathname !== "/"
)
  throw Error("Explicit local control plane required");
const accountFile = process.env.BEAM_TEST_ACCOUNT_FILE;
if (!accountFile || fs.statSync(accountFile).mode & 0o077)
  throw Error("A private mode0600 test-account file is required");
const account = JSON.parse(fs.readFileSync(accountFile, "utf8"));
const phase = process.env.BEAM_TEST_PHASE || "publish";
const profile =
  process.env.BEAM_TEST_PROFILE ||
  fs.mkdtempSync(path.join(os.tmpdir(), "tunnex-beam-authenticated-"));
if (
  !path.isAbsolute(profile) ||
  !profile.startsWith(os.tmpdir()) ||
  !path.basename(profile).startsWith("tunnex-beam-authenticated-")
)
  throw Error("Task-owned temporary profile required");
fs.mkdirSync(profile, { mode: 0o700, recursive: true });
app.setPath("userData", profile);
app.setAppLogsPath(path.join(profile, "logs"));
const stateFile = path.join(profile, "qualification.json");
if (!fs.existsSync(path.join(profile, "tunnex.json")))
  fs.writeFileSync(
    path.join(profile, "tunnex.json"),
    JSON.stringify({
      serverUrl: cp.origin,
      importedProfileId: "",
      managedOrganizationSelections: {},
    }),
    { mode: 0o600 },
  );
process.env.TUNNEX_BUNDLE_DIR = path.resolve(__dirname, "../../web/dist");
require("electron-log").transports.file.resolvePathFn = () =>
  path.join(profile, "logs", "main.log");
let cookie;
let consentCompleted = false;
let openedLink;
let tray;
let win;
let origin;
let createdIds = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function browserRequest(route, body, method = "POST") {
  const response = await fetch(cp.origin + route, {
    method,
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Origin: cp.origin,
      "X-Tunnex-CSRF": "1",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw Error(`CP browser fixture request ${route}: HTTP ${response.status}`);
  const cookies = response.headers.getSetCookie();
  if (cookies.length)
    cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  return response.status === 204 ? undefined : response.json();
}
async function loginBrowser() {
  const login = await browserRequest("/api/v1/auth/login", {
    email: account.email,
    password: account.password,
  });
  if (login.mfa_required || login.user?.must_change_password || !cookie)
    throw Error("Test account has not completed normal login prerequisites");
}
// Only OS dispatch is replaced in this qualification process. The real consent
// endpoint consumes a fresh cookie session; no token, verifier or key enters JS
// in the renderer. The production code receives the exact callback it requested.
const dispatchOpenExternal = shell.openExternal.bind(shell);
shell.openExternal = async (raw) => {
  const url = new URL(raw);
  if (url.origin === cp.origin && url.pathname === "/cli-auth") {
    await loginBrowser();
    const redirect = new URL(url.searchParams.get("redirect_uri"));
    if (
      redirect.hostname !== "127.0.0.1" ||
      redirect.protocol !== "http:" ||
      redirect.pathname !== "/callback" ||
      !redirect.port
    )
      throw Error("Unsafe production callback");
    const grant = await browserRequest("/api/v1/auth/cli/authorize", {
      redirect_uri: redirect.href,
      code_challenge: url.searchParams.get("code_challenge"),
      state: url.searchParams.get("state"),
    });
    redirect.searchParams.set("code", grant.code);
    redirect.searchParams.set("state", grant.state);
    const response = await fetch(redirect, { redirect: "error" });
    assert.equal(response.status, 200);
    consentCompleted = true;
  } else {
    assert.equal(url.protocol, "https:");
    openedLink = url.href;
    if (["development", "refresh"].includes(phase))
      return dispatchOpenExternal(raw);
  }
};
const { TunnelTray } = require("../dist/main/tray");
const initializeTray = TunnelTray.prototype.init;
TunnelTray.prototype.init = function () {
  tray = this;
  return initializeTray.call(this);
};
const evaluate = (source) => win.webContents.executeJavaScript(source);
async function until(condition, message, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await pause(100);
  }
  throw Error(`${message}${last ? ` (${last.message})` : ""}`);
}
async function click(label, articleName) {
  await until(
    () =>
      evaluate(
        `(()=>{const root=${articleName ? `Array.from(document.querySelectorAll('article')).find(a=>a.querySelector('h3')?.textContent===${JSON.stringify(articleName)})` : "document"};const button=root&&Array.from(root.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return false;button.click();return true})()`,
      ),
    `Button unavailable: ${label}`,
  );
}
async function openBeam() {
  await until(() => evaluate("!!window.tunnex?.beam"), "Preload missing");
  await until(
    () =>
      evaluate("!!document.querySelector('[aria-label=\"Open navigation\"]')"),
    "Navigation missing after login reload",
  );
  if (
    !(await evaluate(
      "!!document.querySelector('[aria-label=\"Tunnex Beam\"]')",
    ))
  ) {
    await evaluate(
      "document.querySelector('[aria-label=\"Open navigation\"]').click()",
    );
    await until(
      () => evaluate("!!document.querySelector('[data-pane=\"beam\"]')"),
      "Beam drawer item missing",
    );
    await evaluate("document.querySelector('[data-pane=\"beam\"]').click()");
  }
  await until(
    () => evaluate("!!document.querySelector('[aria-label=\"Tunnex Beam\"]')"),
    "Beam UI missing",
  );
}
async function view() {
  return evaluate("window.tunnex.beam.view()");
}
async function waitShare(name, state, local) {
  return until(
    async () =>
      (await view()).shares.find(
        (share) =>
          share.name === name &&
          (!state || share.state === state) &&
          (!local || share.local_status === local),
      ),
    `Share ${name} did not become ${state || local}`,
    25000,
  );
}
async function screenshot(name) {
  win.show();
  win.focus();
  win.webContents.setBackgroundThrottling(false);
  await pause(700);
  const file = path.join(profile, `${name}.png`);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}
async function createThroughUI(name, port, duration = 900) {
  await click("New share");
  await evaluate(
    `(()=>{for(const [label,value]of [['App name',${JSON.stringify(name)}],['Local port',${JSON.stringify(String(port))}]]){const input=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
  );
  await pause(100);
  await click("Check app");
  await until(
    () => evaluate("document.body.innerText.includes('App responded')"),
    "Real local origin did not respond",
  );
  await evaluate(
    `(()=>{const select=Array.from(document.querySelectorAll('select')).find(s=>s.closest('label')?.textContent.includes('Link lifetime'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(String(duration))});select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('fieldset input[type=checkbox]').click();})()`,
  );
  await click("Create share");
  const share = await waitShare(name, "active", "live");
  assert.equal(share.grants.length, 1);
  createdIds.push(share.id);
  return share;
}
async function qualifyPublish() {
  // Reload after successful auth may destroy this executeJavaScript context.
  void evaluate("window.tunnex.auth.login().catch(()=>{})").catch(() => {});
  await until(
    async () =>
      consentCompleted &&
      (await evaluate("window.tunnex.auth.status()")).loggedIn,
    "Production PKCE login failed",
    30000,
  );
  await openBeam();
  const initial = await view();
  assert.equal(
    initial.policy.can_publish,
    true,
    "Fixture publisher policy must be configured",
  );
  assert.equal(initial.policy.domain_ready, true);
  assert.ok(
    initial.policy.audience.length,
    "Fixture reviewer audience must be explicit",
  );
  origin = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>Beam desktop origin</title><h1>Actual desktop publisher</h1>",
    );
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = origin.address().port;
  const name = `Desktop qualification ${Date.now()}`;
  let share = await createThroughUI(name, port);
  await click("Copy link", name);
  await until(async () => {
    const actual = await clipboard.readText();
    if (actual !== new URL(share.url).href)
      throw Error(
        `Clipboard value ${JSON.stringify(actual)} differs from ${JSON.stringify(new URL(share.url).href)}`,
      );
    return true;
  }, "Canonical clipboard link missing");
  await click("Open", name);
  await until(
    () => openedLink === new URL(share.url).href,
    "Canonical system browser link missing",
  );
  const liveScreenshot = await screenshot("beam-authenticated-live");
  if (process.env.BEAM_TEST_REVIEW_HANDOFF === "1") {
    const readyFile = path.join(profile, "review-ready.json");
    fs.writeFileSync(
      readyFile,
      JSON.stringify({ id: share.id, url: share.url, profile }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        qualification: "reviewer handoff",
        readyFile,
        id: share.id,
        url: share.url,
      }),
    );
    await until(
      () => fs.existsSync(path.join(profile, "review-complete")),
      "Reviewer handoff did not complete",
      180000,
    );
  }
  win.close();
  await pause(300);
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);
  share = await waitShare(name, "active", "live");
  tray.actions.onShowBeam();
  await pause(300);
  assert.equal(win.isVisible(), true);
  await click("Pause", name);
  await waitShare(name, "paused", "offline");
  await click("Resume", name);
  await waitShare(name, "active", "live");
  await click("Access", name);
  await click("Save access");
  await waitShare(name, "active", "live");
  await until(
    () =>
      evaluate(
        "!Array.from(document.querySelectorAll('h2')).some(h=>h.textContent==='Manage reviewer access')",
      ),
    "Access editor did not save",
  );
  await click("Extend", name);
  await click("Confirm extension", name);
  const extended = await waitShare(name, "active", "live");
  assert.ok(Date.parse(extended.expires_at) > Date.parse(share.expires_at));
  await click("Access", name);
  await evaluate(
    "document.querySelector('fieldset input[type=checkbox]:checked').click()",
  );
  await click("Save access");
  await until(
    () =>
      evaluate(
        "!!document.querySelector('[role=dialog][aria-label=\"Confirm reviewer access removal\"]')",
      ),
    "Removal impact dialog missing",
  );
  const removalScreenshot = await screenshot(
    "beam-authenticated-removal-impact",
  );
  await click("Cancel removal");
  assert.equal((await waitShare(name, "active", "live")).grants.length, 1);
  await click("Save access");
  await click("Remove access");
  await until(
    async () => (await waitShare(name, "active", "live")).grants.length === 0,
    "Confirmed reviewer removal did not apply",
  );
  await click("Access", name);
  await evaluate(
    "document.querySelector('fieldset input[type=checkbox]').click()",
  );
  await click("Save access");
  await until(
    async () => (await waitShare(name, "active", "live")).grants.length === 1,
    "Reviewer restore did not apply",
  );
  await evaluate("void(window.confirm=()=>true)");
  await click("Stop", name);
  await waitShare(name, "stopped", "offline");
  const quitName = `${name} quit`;
  const quitShare = await createThroughUI(quitName, port);
  // Destroying and recreating the detachable view must preserve serving, and
  // the tray's pending navigation must reach Beam in the recreated renderer.
  win.destroy();
  tray.actions.onShowBeam();
  win = BrowserWindow.getAllWindows()[0];
  await until(
    () => evaluate("!!document.querySelector('[aria-label=\"Tunnex Beam\"]')"),
    "Tray reopen lost pending Beam navigation",
  );
  await waitShare(quitName, "active", "live");
  const reopenedScreenshot = await screenshot("beam-authenticated-tray-reopen");
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        profile,
        cp: cp.origin,
        shares: createdIds,
        quitShare: quitShare.id,
        liveScreenshot,
        reopenedScreenshot,
        removalScreenshot,
        pkce: "production main/preload + real CP cookie consent + exact loopback exchange",
        proof: [
          "UI local check and create",
          "explicit reviewer selection",
          "CP admitted native TLS channels",
          "copy/open canonical link",
          "window close keeps serving",
          "tray recreates Beam view",
          "pause/resume",
          "access edit preserves serving",
          "accepted extension preserves serving",
          "reviewer impact preview and cancel",
          "explicit removal confirmation and restore",
          "terminal stop",
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      qualification: "authenticated publisher",
      phase,
      profile,
      resultFile: stateFile,
      liveScreenshot,
      reopenedScreenshot,
    }),
  );
  tray.actions.onQuit();
}
async function qualifyLogin() {
  void evaluate("window.tunnex.auth.login().catch(()=>{})").catch(() => {});
  await until(
    async () =>
      consentCompleted &&
      (await evaluate("window.tunnex.auth.status()")).loggedIn,
    "Production PKCE login failed",
    30000,
  );
  await openBeam();
  const snapshot = await view();
  const shot = await screenshot("beam-authenticated-policy");
  console.log(
    JSON.stringify({
      qualification: "real CP production PKCE login",
      phase,
      profile,
      screenshot: shot,
      policy: {
        enabled: snapshot.policy.enabled,
        canPublish: snapshot.policy.can_publish,
        domainReady: snapshot.policy.domain_ready,
      },
      storedCredentialEncrypted: !fs
        .readFileSync(path.join(profile, "credential.bin"))
        .toString("utf8")
        .includes("tnx_"),
    }),
  );
  await evaluate("window.tunnex.auth.logout()");
  app.quit();
}
async function qualifyReopen() {
  await loginBrowser();
  await openBeam();
  const previous = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const snapshot = await view();
  for (const id of previous.shares) {
    const share = snapshot.shares.find((item) => item.id === id);
    assert.equal(
      share?.state,
      "stopped",
      "Clean quit must commit server stop before exit",
    );
    assert.equal(share.local_status, "offline");
    assert.equal(
      await evaluate(
        `window.tunnex.beam.retry(${JSON.stringify(id)}).then(()=>false,()=>true)`,
      ),
      true,
    );
  }
  const reopenedScreenshot = await screenshot("beam-authenticated-after-quit");
  await evaluate("window.tunnex.auth.logout()");
  await until(
    async () => !(await evaluate("window.tunnex.auth.status()")).loggedIn,
    "Logout failed",
  );
  const rows = await browserRequest("/api/v1/organizations", undefined, "GET");
  assert.ok(rows, "Real cookie session remains independently usable");
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        ...previous,
        afterQuitScreenshot: reopenedScreenshot,
        reopened: true,
        logout: true,
        credentialRevoke: "production auth.logout",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      qualification: "authenticated publisher",
      phase,
      profile,
      resultFile: stateFile,
      reopenedScreenshot,
      quitStoppedBothShares: true,
      terminalRestartRefused: true,
      logout: true,
    }),
  );
  app.quit();
}
app.whenReady().then(async () => {
  try {
    await new Promise((resolve) =>
      app.once("browser-window-created", (_event, window) =>
        window.webContents.once("did-finish-load", resolve),
      ),
    );
    win = BrowserWindow.getAllWindows()[0];
    if (phase === "login") await qualifyLogin();
    else if (phase === "publish") await qualifyPublish();
    else if (phase === "reopen") await qualifyReopen();
    else if (["development", "refresh"].includes(phase)) {
      if (phase === "development") {
        void evaluate("window.tunnex.auth.login().catch(()=>{})").catch(
          () => {},
        );
        await until(
          async () =>
            consentCompleted &&
            (await evaluate("window.tunnex.auth.status()")).loggedIn,
          "Production dev PKCE login failed",
          30000,
        );
      } else {
        await until(
          async () => (await evaluate("window.tunnex.auth.status()")).loggedIn,
          "Normal encrypted credential restore failed",
          30000,
        );
      }
      await openBeam();
      if (phase === "refresh") {
        const retained = (await view()).shares.find(
          (s) => s.id === process.env.BEAM_TEST_RESUME_DEMO,
        );
        assert.ok(
          retained && retained.state === "paused",
          "Explicit retained paused demo required",
        );
        await click("Resume", retained.name);
        const resumed = await waitShare(retained.name, "active", "live");
        assert.equal(resumed.id, retained.id);
        assert.equal(resumed.url, retained.url);
        assert.equal(resumed.expires_at, retained.expires_at);
        console.log(
          JSON.stringify({
            mode: "explicit resumed demo",
            id: resumed.id,
            url: resumed.url,
            expires_at: resumed.expires_at,
          }),
        );
      }
      if (process.env.BEAM_TEST_CREATE_DEMO === "1") {
        const demoPort = Number(process.env.BEAM_TEST_DEMO_PORT);
        if (!Number.isInteger(demoPort) || demoPort < 1 || demoPort > 65535)
          throw Error("Explicit local demo port required");
        const demo = await createThroughUI(
          "Tunnex Beam local demo",
          demoPort,
          7200,
        );
        console.log(
          JSON.stringify({
            mode: "explicit owned demo share",
            id: demo.id,
            url: demo.url,
            expires_at: demo.expires_at,
          }),
        );
      }
      await screenshot("beam-development-signed-in");
      console.log(
        JSON.stringify({
          mode: "persistent signed-in desktop development",
          pid: process.pid,
          profile,
          server: cp.origin,
        }),
      );
    } else throw Error("Unknown qualification phase");
  } catch (error) {
    console.error(`Authenticated Beam qualification failed: ${error.message}`);
    // Production logout withdraws any surviving local shares and revokes only
    // this qualification profile's CLI credential.
    if (phase !== "refresh" && win && !win.isDestroyed())
      await evaluate("window.tunnex?.auth.logout().catch(()=>{})").catch(
        () => {},
      );
    app.exit(1);
  }
});
if (!["development", "refresh"].includes(phase))
  setTimeout(() => {
    console.error("Authenticated Beam qualification timed out");
    app.quit();
  }, 300000).unref();
require("../dist/main/index.js");
