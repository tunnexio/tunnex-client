import { fixtureViewer } from "./beamviewer";
// Real Vite 6 HMR through the production native channel pool. The Go transport
// fixture injects authority and adapts loopback HTTP Origin; it is not CP login.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBeamChannelPool } from "../src/main/beamchannelpool";
import type { BeamBinding, BeamChannelOptions } from "../src/main/beamconnector";
import type { ViteDevServer, InlineConfig } from "../../web/node_modules/vite/dist/node/index";

type Metadata = { proxyUrl: string; viewerUrl: string; controlUrl: string; reviewToken: string; controlToken: string; binding: BeamBinding };
type HMRMessage = { type: string; updates?: { type: string; path: string; acceptedPath: string; timestamp: number }[] };
async function until(check: () => Promise<boolean>, message: string, milliseconds = 7000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await new Promise(done => setTimeout(done, 25)); }
  assert.fail(message);
}

async function openHMR(base: string, cookie: string, token: string, ca: string): Promise<{ socket: net.Socket; messages: HMRMessage[] }> {
  return new Promise((done, fail) => {
    const messages: HMRMessage[] = [];
    const request = fixtureViewer(ca).request(base + "/?token=" + encodeURIComponent(token), { headers: { Cookie: cookie, Origin: base, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Protocol": "vite-hmr", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13" } });
    request.once("error", fail);
    request.once("response", response => { response.resume(); fail(new Error(`Vite HMR refused status ${response.statusCode}`)); });
    request.once("upgrade", (response, socket, head) => {
      assert.equal(response.headers["sec-websocket-protocol"], "vite-hmr");
      let buffered = Buffer.alloc(0), fragments: Buffer[] = [];
      socket.on("error", () => {});
      const frames = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 15, complete = Boolean(buffered[0] & 128);
          let size = buffered[1] & 127, offset = 2;
          assert.equal(buffered[1] & 128, 0, "server HMR messages are unmasked");
          if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); offset = 4; }
          if (size === 127) { if (buffered.length < 10) return; const large = buffered.readBigUInt64BE(2); assert.ok(large <= 1_048_576n, "HMR test message exceeded its bounded parser"); size = Number(large); offset = 10; }
          assert.ok(size <= 1_048_576, "HMR frame exceeded its bounded parser");
          if (buffered.length < offset + size) return;
          const payload = buffered.subarray(offset, offset + size); buffered = buffered.subarray(offset + size);
          if (opcode === 1 || opcode === 0) {
            if (opcode === 1) fragments = [];
            fragments.push(payload);
            if (complete) { messages.push(JSON.parse(Buffer.concat(fragments).toString("utf8"))); fragments = []; }
          }
        }
      };
      socket.on("data", frames); if (head.length) frames(head);
      done({ socket, messages });
    });
    request.end();
  });
}

function source(version: string) { return `export const version = ${JSON.stringify(version)};\ndocument.querySelector('#version').textContent = version;\nif (import.meta.hot) import.meta.hot.accept();\n`; }

test("actual Vite HMR update and assets coexist with SSE over the bounded Beam pool", { timeout: 40_000 }, async t => {
  const binary = process.env.BEAM_SPIKE_BIN;
  assert.ok(binary, "BEAM_SPIKE_BIN must name the real Go fixture; HMR qualification is never skipped");
  await access(binary);
  const directory = await mkdtemp(join(tmpdir(), "tunnex-beam-vite-"));
  const core = spawn(binary, ["--fixture-dir", directory, "--ttl", "1m"], { stdio: ["ignore", "ignore", "pipe"] });
  let fixtureError = ""; core.stderr.on("data", chunk => { fixtureError += String(chunk); });
  const exited = new Promise<void>(done => core.once("exit", () => done()));
  const controller = new AbortController();
  let pool: Promise<void> | undefined; let vite: ViteDevServer | undefined; let hmr: Awaited<ReturnType<typeof openHMR>> | undefined; let sse: http.ClientRequest | undefined;
  t.after(async () => { controller.abort(); hmr?.socket.destroy(); sse?.destroy(); if (pool) await pool; if (vite) await vite.close(); core.kill("SIGTERM"); await exited; });
  await until(async () => { assert.equal(core.exitCode, null, fixtureError || "Go fixture exited"); try { await access(join(directory, "metadata.json")); return true; } catch { return false; } }, "Go transport fixture readiness timed out");
  const metadata: Metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
  const viewer = fixtureViewer(await readFile(join(directory, "ca.pem"), "utf8"));
  const fetch = viewer.fetch;
  const requestedRoot = join(directory, "vite-app"); await mkdir(join(requestedRoot, "src"), { recursive: true });
  const appRoot = await realpath(requestedRoot);
  const modulePath = join(appRoot, "src/main.js");
  await writeFile(modulePath, source("version-one"));
  await writeFile(join(appRoot, "index.html"), '<!doctype html><html><head><title>Beam actual Vite fixture</title></head><body><h1 id="version">Waiting for Vite</h1><script type="module" src="/src/main.js"></script></body></html>');
  await writeFile(join(appRoot, "proof.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><title>Beam asset proof</title><rect width="20" height="20" fill="green"/></svg>');
  // ts-node compiles this test as CommonJS. Keep Vite's supported native ESM
  // import instead of lowering dynamic import into require().
  const importESM = new Function("path", "return import(path)") as (path: string) => Promise<{ createServer: (config: InlineConfig) => Promise<ViteDevServer> }>;
  const viteURL = pathToFileURL(resolve(__dirname, "../../web/node_modules/vite/dist/node/index.js")).href;
  const viteModule = await importESM(viteURL);
  const fixturePlugin = { name: "beam-owned-sse-fixture", configureServer(server: ViteDevServer) {
    server.middlewares.use("/events", (_req: http.IncomingMessage, response: http.ServerResponse) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write("data: vite-sse-ready\n\n");
      const timer = setInterval(() => response.write("data: vite-sse-live\n\n"), 80);
      response.once("close", () => clearInterval(timer));
    });
  } };
  vite = await viteModule.createServer({
    root: appRoot, configFile: false, envFile: false, logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, allowedHosts: [metadata.binding.hostname], watch: { usePolling: true, interval: 50 }, hmr: { protocol: "wss", host: metadata.binding.hostname, clientPort: 443 } },
    plugins: [fixturePlugin],
  });
  await vite.listen();
  const port = (vite.httpServer!.address() as net.AddressInfo).port;
  const options: BeamChannelOptions = { proxyUrl: metadata.proxyUrl, binding: metadata.binding, target: { address: "127.0.0.1", port }, identity: { ca: await readFile(join(directory, "ca.pem"), "utf8"), cert: await readFile(join(directory, "connector.pem"), "utf8"), key: await readFile(join(directory, "connector-key.pem"), "utf8") } };
  let maxConnected = 0;
  pool = runBeamChannelPool(options, controller.signal, status => { maxConnected = Math.max(maxConnected, status.connected + status.opening); });
  const ready = () => until(async () => { const status = await fetch(metadata.controlUrl + "/status").then(response => response.json()) as { capacity: { Ready: number } }; return status.capacity.Ready >= 2; }, "production pool did not replenish two idle channels");
  await ready(); const cookie = `beam_fixture_review=${metadata.reviewToken}`;
  const get = async (path: string) => { const response = await fetch(metadata.viewerUrl + path, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, path); return response.text(); };
  assert.match(await get("/"), /\/src\/main\.js/);
  assert.match(await get("/src/main.js"), /version-one/);
  const client = await get("/@vite/client");
  assert.match(client, /const socketProtocol = "wss"/);
  assert.ok(client.includes(JSON.stringify(metadata.binding.hostname)), "injected client must use the approved Beam hostname");
  assert.match(client, /const hmrPort = 443/);
  const tokenMatch = client.match(/const wsToken = "([^"]+)"/);
  assert.ok(tokenMatch, "real Vite client must provide its own current HMR token");
  await ready();
  hmr = await openHMR(metadata.viewerUrl, cookie, tokenMatch[1], options.identity.ca);
  const activeHMR = hmr;
  await until(async () => activeHMR.messages.some(message => message.type === "connected"), "Vite HMR connected message was not proxied");
  let sseChunks = 0; let closedSSE!: () => void;
  const sseClosed = new Promise<void>(done => { closedSSE = done; });
  sse = viewer.get(metadata.viewerUrl + "/events", { headers: { Cookie: cookie } });
  await new Promise<void>((done, fail) => { sse!.once("error", fail); sse!.once("response", response => { assert.equal(response.statusCode, 200); response.once("close", closedSSE); response.on("error", () => {}); response.on("data", chunk => { assert.match(String(chunk), /data: vite-sse-/); sseChunks++; if (sseChunks === 1) done(); }); }); });
  const initialSSE = sseChunks;
  // A real file-system edit drives Vite's watcher/module graph. No synthetic
  // ws.send() call or watcher.emit() is allowed to fabricate this evidence.
  const editedAt = Date.now();
  await writeFile(modulePath, source("version-two"));
  await until(async () => activeHMR.messages.some(message => message.type === "update" && message.updates?.some(update => update.path === "/src/main.js")), "real file edit did not reach the HMR WebSocket");
  const update = activeHMR.messages.find(message => message.type === "update")!.updates!.find(value => value.path === "/src/main.js")!;
  assert.equal(update.type, "js-update"); assert.equal(update.acceptedPath, "/src/main.js"); assert.ok(update.timestamp > 0);
  assert.match(await get(`/src/main.js?t=${update.timestamp}`), /version-two/);
  assert.match(await get("/proof.svg"), /Beam asset proof/);
  assert.match(await get("/"), /Beam actual Vite fixture/);
  await until(async () => sseChunks > initialSSE, "SSE stalled while HMR and assets were served");
  assert.equal(activeHMR.socket.destroyed, false);
  assert.ok(maxConnected <= 34, "production pool exceeded 32 active plus two idle/opening reservations");
  const hmrClosed = new Promise<void>(done => activeHMR.socket.once("close", () => done()));
  const revoked = Date.now();
  const revoke = await fetch(metadata.controlUrl + "/revoke", { method: "POST", headers: { "X-Beam-Fixture-Control": metadata.controlToken } }); assert.equal(revoke.status, 204);
  await Promise.race([Promise.all([hmrClosed, sseClosed]), new Promise((_done, fail) => setTimeout(() => fail(new Error("Vite HMR/SSE withdrawal exceeded five seconds")), 5000))]);
  const withdrawalMilliseconds = Date.now() - revoked;
  assert.ok(withdrawalMilliseconds < 5000);
  t.diagnostic(`Actual Vite update observed after ${update.timestamp - editedAt}ms; maximum connector reservations ${maxConnected}; HMR and SSE withdrawal ${withdrawalMilliseconds}ms.`);
});
