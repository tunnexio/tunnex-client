import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelController, supportsRelayMode } from "../src/main/tunnel";
import { FrameDecoder, encodeFrame, type TunnelConfig } from "../src/main/helperclient";
import { ConnectivityApi, prepareRelayConnectivity, assertNegotiatedOffersUnchanged, validateConnectivitySession, type ConnectivitySession } from "../src/main/connectivityapi";
const realFetch = globalThis.fetch;
test("relay reconnect refreshes stored gateway A to current dial/session B without replacing device identity", async () => {
  const nextKey=Buffer.alloc(32,3).toString("base64");
  const config={ private_key:"private-device-identity", peer_public_key:binding.gatewayPublicKey, endpoint:"192.0.2.1:51820", address:"10.99.0.2/32" } as TunnelConfig;
  globalThis.fetch=(async url => String(url).endsWith("connectivity-profile") ? Response.json({enabled:true}) : Response.json({...session(),gateway_public_key:nextKey})) as typeof fetch;
  const api=await prepareRelayConnectivity("https://cp.example","burner",binding,config,async()=>({dial:{endpoint:"192.0.2.2:51820",pubkey:nextKey}}),()=>{});
  assert.equal((await api!.create()).gateway_public_key,nextKey);
  assert.equal(config.endpoint,"192.0.2.2:51820");
  assert.equal(config.private_key,"private-device-identity");
  assert.equal(config.address,"10.99.0.2/32");
});
test("stale or inconclusive dial refresh cannot mutate the stored configuration", async () => {
  globalThis.fetch=(async()=>Response.json({enabled:true})) as typeof fetch;
  const config={peer_public_key:binding.gatewayPublicKey,endpoint:"192.0.2.1:51820"} as TunnelConfig;
  let current=true;
  await assert.rejects(prepareRelayConnectivity("https://cp.example","burner",binding,config,async()=>{current=false;return {dial:{endpoint:"192.0.2.2:51820",pubkey:binding.devicePublicKey}};},()=>{if(!current)throw Error("stale-owner");}),/stale-owner/);
  assert.equal(config.endpoint,"192.0.2.1:51820");
  await assert.rejects(prepareRelayConnectivity("https://cp.example","burner",binding,config,async()=>{throw Error("CP unavailable");},()=>{}),/CP unavailable/);
});
test("relay platform guard permits desktop split tunnels but never full tunnels", () => {
  for (const platform of ["darwin", "win32", "linux", "freebsd"] as const) {
    assert.equal(supportsRelayMode(platform, false), platform === "darwin" || platform === "win32");
    assert.equal(supportsRelayMode(platform, true), false);
  }
});
test("established transport refuses replacement offers instead of renewing a dead carrier", () => {
  const previous = session();
  assert.doesNotThrow(() => assertNegotiatedOffersUnchanged(previous, { ...previous }));
  for (const patch of [
    { gateway_sequence: previous.gateway_sequence + 1 },
    { gateway_payload: '{"replacement":true}' },
    { device_sequence: previous.device_sequence + 1 },
    { device_payload: '{"replacement":true}' },
  ]) assert.throws(() => assertNegotiatedOffersUnchanged(previous, { ...previous, ...patch }), /relay_negotiation_changed/);
});
afterEach(() => { globalThis.fetch = realFetch; });
const binding = {
  orgId: "00000000-0000-4000-8000-000000000001",
  deviceId: "00000000-0000-4000-8000-000000000002",
  gatewayId: "00000000-0000-4000-8000-000000000003",
  devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
  gatewayPublicKey: Buffer.alloc(32, 2).toString("base64"),
};
function session(): ConnectivitySession {
  return { session_id: "00000000-0000-4000-8000-000000000004", device_id: binding.deviceId,
    gateway_id: binding.gatewayId, device_public_key: binding.devicePublicKey, gateway_public_key: binding.gatewayPublicKey,
    generation: 1, expires_at: new Date(Date.now() + 120000).toISOString(), device_sequence: 0,
    gateway_sequence: 0, device_payload: "{}", gateway_payload: "{}" };
}
test("connectivity response binds device, gateway, keys, generation and expiry", () => {
  const good = session();
  assert.deepEqual(validateConnectivitySession(good, binding), good);
  for (const patch of [
    { device_id: binding.gatewayId }, { gateway_id: binding.deviceId },
    { device_public_key: binding.gatewayPublicKey }, { gateway_public_key: binding.devicePublicKey },
    { generation: 0 }, { generation: 2 }, { device_sequence: 65 },
    { expires_at: "invalid" }, { expires_at: new Date(0).toISOString() },
    { session_id: binding.orgId }, { device_payload: "x".repeat(16385) },
  ]) assert.throws(() => validateConnectivitySession({ ...good, ...patch }, binding, good), /invalid_response/);
});
test("connectivity keeps bearer on fixed HTTPS origin and forbids redirects", async () => {
  const good = session();
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), `https://cp.example/api/v1/organizations/${binding.orgId}/devices/${binding.deviceId}/connectivity-sessions`);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer burner");
    return Response.json(good);
  }) as typeof fetch;
  assert.deepEqual(await new ConnectivityApi("https://cp.example", "burner", binding).create(), good);
  assert.equal(calls, 1);
  for (const origin of ["http://cp.example", "https://user:pass@cp.example", "https://cp.example/path", "https://cp.example?x=y"]) {
    assert.throws(() => new ConnectivityApi(origin, "burner", binding));
  }
});
test("connectivity refuses oversized and secret-bearing failure responses", async () => {
  const api = new ConnectivityApi("https://cp.example", "bearer-secret", binding);
  globalThis.fetch = (async () => new Response("candidate-secret", { status: 403 })) as typeof fetch;
  await assert.rejects(api.create(), { message: "connectivity_refused_403" });
  globalThis.fetch = (async () => new Response("x".repeat(131073))) as typeof fetch;
  await assert.rejects(api.create(), { message: "connectivity_invalid_response" });
  globalThis.fetch = (async () => { throw new Error("bearer-secret"); }) as typeof fetch;
  await assert.rejects(api.create(), { message: "connectivity_control_unavailable" });
});
test("connectivity publishes next sequence and rejects arrays before fetch", async () => {
  const s = session();
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    assert.equal(init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(init?.body)), { sequence: 1, payload: "{}" });
    return Response.json({ ...s, device_sequence: 1 });
  }) as typeof fetch;
  const api = new ConnectivityApi("https://cp.example", "burner", binding);
  assert.equal((await api.publish(s, "{}")).device_sequence, 1);
  await assert.rejects(api.publish(s, "[]"), /invalid_snapshot/);
  assert.equal(calls, 1);
});

for (const mode of ["normal", "changed-endpoint", "changed-key", "slow-prepare", "slow-up"] as const) {
test(`${mode} Connect brokers offers over CP and scoped material over helper IPC`, { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnx-relay-ipc-"));
  const socket = path.join(dir, "helper.sock");
  const verbs: string[] = [];
  const s = session();
  s.gateway_payload = '{"gateway":"offer"}';
  s.relay = { url: "turns:relay.example:5349?transport=tcp", username: "scoped", password: "turn-only", expires_at: new Date(Date.now() + 60000).toISOString() };
  const server = net.createServer((sock) => {
    const decoder = new FrameDecoder();
    sock.on("data", (data) => {
      for (const raw of decoder.push(data)) {
        const req = raw as Record<string, unknown>;
        verbs.push(String(req.verb));
        assert.ok(!JSON.stringify(req).includes("CP-BEARER-ONLY"), "CP bearer must not cross helper IPC");
        if (req.verb === "relay_prepare") {
          const reply = () => sock.write(encodeFrame({ version: 1, ok: true, relay_offer: '{"device":"offer"}' }));
          if (mode === "slow-prepare") setTimeout(reply, 16000); else reply();
        }
        else {
          if (req.verb === "tunnel_up") assert.equal(req.relay_remote, s.gateway_payload);
          const reply = () => sock.write(encodeFrame({ version: 1, ok: true, status: { state: req.verb === "tunnel_down" ? "down" : "up" } }));
          if (mode === "slow-up" && req.verb === "tunnel_up") setTimeout(reply, 16000); else reply();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("connectivity-profile")) return Response.json({ enabled: true });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "PUT") {
      assert.deepEqual(JSON.parse(String(init.body)), { sequence: 1, payload: '{"device":"offer"}' });
      return Response.json({ ...s, device_sequence: 1 });
    }
    return Response.json(s);
  }) as typeof fetch;
  const failures: string[] = [];
  const controller = new TunnelController(socket, status => { if (status.recovery_reason) failures.push(status.recovery_reason); });
  try {
    const result = await controller.up(async () => ({ address: "10.99.0.2/32", allowed_ips: ["10.0.0.0/24"] }) as TunnelConfig,
      async () => ({ api: new ConnectivityApi("https://cp.example", "CP-BEARER-ONLY", binding), assertCurrent: () => {} }));
    assert.equal(result.state, "up");
    if (mode === "changed-endpoint" || mode === "changed-key") {
      await controller.setGatewayPeer(mode === "changed-key" ? binding.devicePublicKey : binding.gatewayPublicKey,
        mode === "changed-endpoint" ? "192.0.2.2:51820" : "192.0.2.1:51820");
      assert.deepEqual(failures, ["relay_negotiation_changed"]);
      await assert.rejects(controller.setGatewayPeer(binding.gatewayPublicKey, "192.0.2.3:51820"), /cleanup_required/);
      assert.ok(!verbs.includes("set_gateway_peer"), "old carrier must never receive an in-place swap");
    }
    await controller.down();
    assert.deepEqual(verbs, ["relay_prepare", "relay_authorize", "tunnel_up",
      ...(mode === "changed-endpoint" || mode === "changed-key" ? ["set_resolvers"] : []), "tunnel_down"]);
  } finally {
    await controller.down();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmdirSync(dir);
  }
});
}

for (const scenario of ["replacement", "renewal", "refusal", "gateway_moved", "helper_loss", "cp500", "cp_outage"] as const) {
test(`${scenario} closes relay owner and cannot be masked by helper Up`, { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnx-relay-replaced-"));
  const socket = path.join(dir, "helper.sock");
  const verbs: string[] = [];
  const s = session();
  if (scenario === "renewal" || scenario === "refusal") s.expires_at = new Date(Date.now() + 45000).toISOString();
  s.gateway_sequence = 1;
  s.gateway_payload = '{"gateway":"original"}';
  s.relay = { url: "turns:relay.example:5349?transport=tcp", username: "scoped", password: "turn-only", expires_at: new Date(Date.now() + (scenario === "cp_outage" ? 60000 : 30000)).toISOString() };
  const server = net.createServer(sock => {
    const decoder = new FrameDecoder();
    sock.on("data", data => {
      for (const raw of decoder.push(data)) {
        const req = raw as { verb: string };
        verbs.push(req.verb);
        if (scenario === "helper_loss" && req.verb === "relay_authorize"
          && verbs.filter(v => v === "relay_authorize").length > 1) {
          sock.write(encodeFrame({ version: 1, ok: false, code: "relay_unavailable" }));
          continue;
        }
        sock.write(encodeFrame({ version: 1, ok: true, relay_offer: "{}", status: { state: req.verb === "tunnel_down" ? "down" : "up" } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  let reads = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("connectivity-profile")) return Response.json({ enabled: true });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "GET") {
      if (scenario === "cp_outage") return new Response(null, { status: 500 });
      if (scenario === "cp500" && ++reads === 1) return new Response(null, { status: 500 });
      if (scenario === "refusal") return new Response(null, { status: 403 });
      if (scenario === "gateway_moved") return new Response(null, { status: 409 });
      return Response.json(scenario === "replacement" || scenario === "cp500"
        ? { ...s, gateway_sequence: 2, gateway_payload: '{"gateway":"replacement"}' } : s);
    }
    return Response.json(s);
  }) as typeof fetch;
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const reasons: Array<string | undefined> = [];
  const controller = new TunnelController(socket, status => {
    if (status.state === "failed") { reasons.push(status.recovery_reason); failed(); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await controller.up(async () => ({ address: "10.99.0.2/32", allowed_ips: ["10.0.0.0/24"] }) as TunnelConfig,
      async () => ({ api: new ConnectivityApi("https://cp.example", "burner", binding), assertCurrent: () => {} }));
    await Promise.race([failure, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("replacement was not failed closed")), scenario === "cp_outage" ? 43000 : scenario === "cp500" ? 23000 : 13000); })]);
    assert.equal(verbs.filter(verb => verb === "relay_authorize").length, scenario === "helper_loss" ? 2 : 1, "no successful lease extension on a terminal generation");
    assert.deepEqual(reasons, [scenario === "replacement" || scenario === "cp500" || scenario === "gateway_moved" ? "relay_negotiation_changed"
      : scenario === "renewal" ? "relay_session_renewal"
        : scenario === "helper_loss" || scenario === "cp_outage" ? "relay_transport_lost" : undefined], "refusal must never schedule renewal");
    assert.equal((await controller.status()).state, "failed");
  } finally {
    clearTimeout(timer);
    await controller.down();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmdirSync(dir);
  }
});
}
