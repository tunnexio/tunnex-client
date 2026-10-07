import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBeamChannel, type BeamBinding, type BeamChannelOptions } from "../src/main/beamconnector";
import { startBeamFixtureApp } from "./beamfixture";
import { runBeamFixturePool } from "./beampool";

interface Fixture {
  proxyUrl: string; viewerUrl: string; controlUrl: string;
  reviewToken: string; controlToken: string; binding: BeamBinding;
}

async function until(check: () => Promise<boolean>, message: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(message);
}

async function websocket(url: string, cookie: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const request = http.request(url + "/echo", { headers: { Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", Origin: url, "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13" } });
    request.once("upgrade", (_response, socket) => resolve(socket));
    request.once("error", reject);
    request.once("response", response => { response.resume(); reject(new Error(`upgrade status ${response.statusCode}`)); });
    request.end();
  });
}

async function echo(socket: net.Socket, text: string): Promise<string> {
  const payload = Buffer.from(text), mask = randomBytes(4), masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  const result = new Promise<string>((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error("websocket echo timeout")); }, 3000);
    const cleanup = () => { clearTimeout(timer); socket.off("data", receive); socket.off("error", fail); };
    const fail = () => { cleanup(); reject(new Error("websocket echo closed")); };
    const receive = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 2 || data.length < 2 + (data[1] & 0x7f)) return;
      cleanup(); resolve(data.subarray(2, 2 + (data[1] & 0x7f)).toString());
    };
    socket.on("data", receive); socket.once("error", fail);
  });
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]));
  return result;
}

for (const withdrawal of ["revoke", "authority-down"]) {
  test(`native Beam HTTP SSE WebSocket and ${withdrawal} close active traffic`, { timeout: 25_000 }, async t => {
    const binary = process.env.BEAM_SPIKE_BIN;
    assert.ok(binary, "BEAM_SPIKE_BIN must name the built core fixture; integration is never silently skipped");
    await access(binary);
    const directory = await mkdtemp(join(tmpdir(), "tunnex-beam-integration-"));
    const child = spawn(binary, ["--fixture-dir", directory, "--ttl", "45s"], { stdio: ["ignore", "ignore", "pipe"] });
    let safeError = "";
    child.stderr.on("data", chunk => { safeError += String(chunk); });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    t.after(async () => { child.kill("SIGTERM"); await exited; });
    await until(async () => {
      assert.equal(child.exitCode, null, safeError || "fixture exited before readiness");
      try { await access(join(directory, "metadata.json")); return true; } catch { return false; }
    }, "core fixture did not start");
    const metadata: Fixture = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
    const app = await startBeamFixtureApp();
    t.after(() => { app.server.closeAllConnections(); app.server.close(); });
    const api = http.createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify({path:req.url,authority:req.headers["x-app-digest"]??null}));});
    await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
    const apiAddress=api.address();assert.ok(apiAddress&&typeof apiAddress!=="string");
    t.after(()=>{api.closeAllConnections();api.close();});
    const options: BeamChannelOptions = {
      proxyUrl: metadata.proxyUrl, binding: metadata.binding,
      target: { address: "127.0.0.1", port: app.port, protocol:"http", routes:[{path_prefix:"/api",target:{address:"127.0.0.1",port:apiAddress.port,protocol:"http"}}] },
      identity: { ca: await readFile(join(directory, "ca.pem"), "utf8"), cert: await readFile(join(directory, "connector.pem"), "utf8"), key: await readFile(join(directory, "connector-key.pem"), "utf8") },
    };
    const attempt = new AbortController();
    await assert.rejects(openBeamChannel({ ...options, binding: { ...options.binding, orgId: "99999999-0000-4000-8000-000000000009" } }, attempt.signal), /beam_channel_refused/);
    await assert.rejects(openBeamChannel({ ...options, identity: { ...options.identity, cert: await readFile(join(directory, "foreign.pem"), "utf8"), key: await readFile(join(directory, "foreign-key.pem"), "utf8") } }, attempt.signal), /beam_channel_refused/);
    // A TLS-valid but unknown certificate must not borrow the legitimate binding.
    const immutable = { ...options, target: { ...options.target }, binding: { ...options.binding } };
    const connecting = openBeamChannel(immutable, attempt.signal);
    immutable.target.port = 1;
    immutable.binding.hostname = "foreign.beam.example";
    const captured = await connecting;
    const capturedResponse = await fetch(metadata.viewerUrl, { headers: { Cookie: `beam_fixture_review=${metadata.reviewToken}` } });
    assert.equal(capturedResponse.status, 200);
    assert.match(await capturedResponse.text(), /Your local app is reaching the browser/);
    await captured.closed;
    // A caller edit during the handshake cannot change the already captured app.
    const run = new AbortController();
    const pool = runBeamFixturePool(options, run.signal);
    t.after(async () => { run.abort(); await pool; });
    const ready = () => until(async () => {
      const status = await fetch(metadata.controlUrl + "/status").then(response => response.json()) as { capacity: { Ready: number } };
      return status.capacity.Ready >= 2;
    }, "connector pool did not become ready");
    await ready();
    const cookie = `beam_fixture_review=${metadata.reviewToken}`;
    const denied = await fetch(metadata.viewerUrl);
    assert.equal(denied.status, 403); await denied.text();
    const page = await fetch(metadata.viewerUrl, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /Your local app is reaching the browser/);
    await ready();
    const apiResponse=await fetch(metadata.viewerUrl+"/api/orders?limit=2",{headers:{Cookie:cookie}});
    assert.equal(apiResponse.status,200);assert.deepEqual(await apiResponse.json(),{path:"/api/orders?limit=2",authority:null});await ready();
    const boundary=await fetch(metadata.viewerUrl+"/apiary",{headers:{Cookie:cookie}});assert.match(await boundary.text(),/Your local app is reaching the browser/);await ready();
    const inspection = await fetch(metadata.viewerUrl + "/headers", { headers: { Cookie: `${cookie}; __Host-tunnex_session=tnx_fixture; __Host-tunnex_beam_session=beam_fixture; app_theme=green`, Authorization: "Bearer tnx_fixture", "X-Tunnex-User": "foreign", "X-App-ID": "spoofed", "X-Forwarded-For": "spoofed" } });
    assert.equal(inspection.status, 200);
    const headers = await inspection.json() as Record<string, string>;
    assert.equal(headers.host, metadata.binding.hostname);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-tunnex-user"], undefined);
    assert.equal(headers["x-app-id"], undefined);
    assert.equal(headers["x-forwarded-for"], undefined);
    assert.equal(headers.cookie?.trim(), "app_theme=green");
    assert.equal(headers["x-forwarded-host"], metadata.binding.hostname);
    await ready();
    for (const path of ["/escape", "/wide-cookie"]) {
      const response = await fetch(metadata.viewerUrl + path, { headers: { Cookie: cookie }, redirect: "manual" });
      assert.equal(response.status, 502); await response.text(); await ready();
    }
    const redirect = await fetch(metadata.viewerUrl + "/redirect", { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `https://${metadata.binding.hostname}/review`);
    await redirect.text(); await ready();
    const body = await fetch(metadata.viewerUrl + "/echo-body", { method: "POST", headers: { Cookie: cookie }, body: "review-payload" });
    assert.equal(body.status, 200); assert.equal(await body.text(), "review-payload");
    await ready();

    let closeSSE!: () => void;
    const sseClosed = new Promise<void>(resolve => { closeSSE = resolve; });
    const sse = http.get(metadata.viewerUrl + "/events", { headers: { Cookie: cookie } });
    await new Promise<void>((resolve, reject) => {
      sse.once("error", reject);
      sse.once("response", response => {
        assert.equal(response.statusCode, 200);
        response.once("data", chunk => { assert.match(String(chunk), /data: local-/); resolve(); });
        response.once("error", () => {}); response.once("close", closeSSE);
      });
    });
    t.after(() => sse.destroy());
    const ws = await websocket(metadata.viewerUrl, cookie);
    ws.on("error", () => {}); t.after(() => ws.destroy());
    assert.equal(await echo(ws, "live-review"), "live-review");
    // SSE and HMR/WebSocket remain open while another HTTP request is served.
    const concurrent = await fetch(metadata.viewerUrl + "/headers", {headers:{Cookie:cookie},signal:AbortSignal.timeout(3000)});
    assert.equal(concurrent.status,200);await concurrent.text();
    assert.equal(await echo(ws,"still-live"),"still-live");
    const wsClosed = new Promise<void>(resolve => ws.once("close", () => resolve()));
    const began = Date.now();
    const stopped = await fetch(metadata.controlUrl + "/" + withdrawal, { method: "POST", headers: { "X-Beam-Fixture-Control": metadata.controlToken } });
    assert.equal(stopped.status, 204);
    await Promise.race([Promise.all([sseClosed, wsClosed]), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("lease withdrawal exceeded five seconds")), 5000))]);
    assert.ok(Date.now() - began < 5000);
    const after = await fetch(metadata.viewerUrl, { headers: { Cookie: cookie } });
    assert.equal(after.status, 403); await after.text();
    await assert.rejects(openBeamChannel(options, new AbortController().signal), /beam_channel_refused/);
  });
}
