import {beamTargetDigest} from "../src/main/beamroutes";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createPrivateKey, verify, createPublicKey } from "node:crypto";
import { newBeamIdentity } from "../src/main/beamidentity";
import {
  BeamRuntime,
  canonicalBeamUrl,
  checkBeamTarget,
  validateBeamTarget,
} from "../src/main/beamruntime";
import { BeamApi, requireBeamClientVersion } from "../src/main/beamapi";
import type { BeamShare } from "../src/main/beamtypes";
const id = "12345678-1234-4234-8234-123456789abc";
const share: BeamShare = {
  id,
  publisher_id: id,
  created_at: new Date().toISOString(),
  name: "Checkout",
  url: "https://sample.beam.example",
  hostname: "sample.beam.example",
  target: { address: "127.0.0.1", port: 3000, protocol: "http" },
  state: "active",
  version: 1,
  expires_at: new Date(Date.now() + 7200000).toISOString(),
  grants: [{ subject_kind: "user", subject_id: id }],
};
test("Beam validates immutable loopback target and canonical share navigation", () => {
  assert.equal(validateBeamTarget(share.target).address, "127.0.0.1");
  for (const target of [
    { ...share.target, address: "localhost" },
    { ...share.target, port: NaN },
    { ...share.target, port: 65536 },
    { ...share.target, protocol: "file" },
    { ...share.target, ca_pem: "-----BEGIN CERTIFICATE-----" },
  ])
    assert.throws(() => validateBeamTarget(target));
  for (const url of [
    "http://sample.beam.example",
    "https://other.example",
    "https://sample.beam.example/redirect",
    "https://user:pass@sample.beam.example",
    "https://sample.beam.example:8443",
  ])
    assert.throws(() => canonicalBeamUrl({ ...share, url }));
  assert.equal(canonicalBeamUrl(share), "https://sample.beam.example/");
});
test("generated connector CSR proves possession of RSA key without exposing private key", () => {
  const identity = newBeamIdentity();
  assert.equal(createPrivateKey(identity.key).asymmetricKeyType, "rsa");
  assert.equal(identity.csr.includes("PRIVATE KEY"), false);
  const der = Buffer.from(
    identity.csr
      .split("\n")
      .filter((line) => !line.startsWith("---"))
      .join(""),
    "base64",
  );
  const parse = (offset: number) => {
    let size = der[offset + 1];
    let head = 2;
    if (size & 128) {
      const bytes = size & 127;
      size = 0;
      for (let i = 0; i < bytes; i++) size = (size << 8) + der[offset + 2 + i];
      head += bytes;
    }
    return { start: offset + head, end: offset + head + size };
  };
  const body = parse(0);
  const request = parse(body.start);
  const algorithm = parse(request.end);
  const signature = parse(algorithm.end);
  assert.equal(
    verify(
      "sha256",
      der.subarray(body.start, request.end),
      createPublicKey(identity.key),
      der.subarray(signature.start + 1, signature.end),
    ),
    true,
  );
});
test("local app probe never follows redirects or dials an app supplied destination", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.deepEqual(
      await checkBeamTarget({ ...share.target, port: address.port }),
      { ready: true },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("Beam API pins bearer to captured CP, transforms explicit audience and rejects stale reply", async () => {
  const original = globalThis.fetch;
  let valid = true;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init! });
    if (url.endsWith("/policy"))
      return new Response(
        JSON.stringify({
          enabled: true,
          domain_ready: true,
          can_publish: true,
          max_duration_seconds: 86400,
          max_shares: 5,
        }),
      );
    if (url.endsWith("/audience"))
      return new Response(
        JSON.stringify({
          users: [{ id, name: "Alice" }],
          groups: [{ id, name: "Design" }],
        }),
      );
    return new Response(
      JSON.stringify({ items: [share], server_time: new Date().toISOString() }),
    );
  };
  try {
    const api = new BeamApi({
      server: "https://cp.example",
      token: "tnx_secret",
      orgId: id,
      userId: id,
      expiresAt: share.expires_at,
      assertCurrent: () => {
        if (!valid) throw new Error("changed");
      },
    });
    const view = await api.view();
    assert.equal(view.policy.audience.length, 2);
    assert.equal(JSON.stringify(view).includes("tnx_secret"), false);
    assert.ok(
      requests.every((r) =>
        r.url.startsWith(`https://cp.example/api/v1/organizations/${id}/beam/`),
      ),
    );
    assert.ok(
      requests.every(
        (r) =>
          (r.init.headers as Record<string, string>).Authorization ===
          "Bearer tnx_secret",
      ),
    );
    valid = false;
    await assert.rejects(api.view(), /changed/);
  } finally {
    globalThis.fetch = original;
  }
});
test("startup lists active shares offline and never starts connector until explicit request", async () => {
  const original = globalThis.fetch;
  let connections = 0;
  globalThis.fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("/policy")
          ? {
              enabled: true,
              domain_ready: true,
              can_publish: true,
              max_duration_seconds: 86400,
            }
          : String(input).endsWith("/audience")
            ? { users: [], groups: [] }
            : { items: [share], server_time: new Date().toISOString() },
      ),
    );
  try {
    const runtime = new BeamRuntime(
      async () => ({
        server: "https://cp.example",
        token: "tnx_secret",
        orgId: id,
        userId: id,
        expiresAt: share.expires_at,
        assertCurrent: () => {},
      }),
      async () => {
        connections++;
        throw new Error("should not connect");
      },
    );
    const view = await runtime.view();
    assert.equal(view.shares[0].local_status, "offline");
    assert.equal(connections, 0);
    assert.equal(runtime.activeCount(), 0);
    await runtime.retire();
  } finally {
    globalThis.fetch = original;
  }
});
test("native supervisor aborts both channels on retirement and never resurrects a terminal share", async () => {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let live = {
    ...share,
    expires_at: new Date(Date.now() + 3000).toISOString(),
    target: { ...share.target, port: address.port },
    connectivity: "online",
  };
  const original = globalThis.fetch;
  let closed = 0;
  let channels = 0;
  let stopped = 0;
  let terminal = false;
  globalThis.fetch = async (input, init) => {
    const route = String(input);
    if (route.endsWith("/policy"))
      return new Response(
        JSON.stringify({
          enabled: true,
          domain_ready: true,
          can_publish: true,
          max_duration_seconds: 86400,
        }),
      );
    if (route.endsWith("/audience"))
      return new Response(JSON.stringify({ users: [], groups: [] }));
    if (route.endsWith("/connector")) {
      assert.equal(String(init?.body).includes("PRIVATE KEY"), false);
      return new Response(
        JSON.stringify({
          share_version: 2,
          binding: {
            purpose: "beam_proxy",
            org_id: id,
            gateway_id: id,
            app_id: id,
            generation: id,
            revision: 1,
            digest: beamTargetDigest(live.target),
            hostname: share.hostname,
            authority_version: 1,
          },
          proxy_url: "https://proxy.example",
          proxy_server_name: "tunnex-beam-proxy",
          ca_pem: "TEST CA",
          certificate_pem: "TEST CERT",
          certificate_expires_at: share.expires_at,
          // Current installation proof refreshes; it is not the leaf deadline.
          expires_at: new Date(Date.now() + 500).toISOString(),
        }),
      );
    }
    if (route.endsWith("/heartbeat")) return new Response(JSON.stringify(live));
    if (route.includes("/shares?"))
      return new Response(
        JSON.stringify({
          items: [],
          limit: 20,
          offset: 20,
          server_time: new Date().toISOString(),
        }),
      );
    if (route.endsWith(`/shares/${id}`))
      return new Response(JSON.stringify(live));
    if (route.endsWith("/actions")) {
      const body = JSON.parse(String(init?.body));
      if (body.action === "extend") {
        live = { ...live, version: 3, expires_at: body.expires_at };
        return new Response(JSON.stringify(live));
      }
      stopped++;
      return new Response(JSON.stringify({ ...live, state: "stopped" }));
    }
    if (route.endsWith("/grants")) {
      live = { ...live, version: 4, grants: [] };
      return new Response(JSON.stringify(live));
    }
    return new Response(
      JSON.stringify({
        items: [terminal ? { ...live, state: "stopped" } : live],
        server_time: new Date().toISOString(),
      }),
    );
  };
  let runtime: BeamRuntime | undefined;
  try {
    runtime = new BeamRuntime(
      async () => ({
        server: "https://cp.example",
        token: "tnx_secret",
        orgId: id,
        userId: id,
        expiresAt: share.expires_at,
        assertCurrent: () => {},
      }),
      async (_options, signal) => {
        channels++;
        let end!: () => void;
        const closedPromise = new Promise<void>((resolve) => {
          end = resolve;
        });
        let ended = false;
        const close = () => {
          if (!ended) {
            ended = true;
            closed++;
            end();
          }
        };
        signal.addEventListener("abort", close, { once: true });
        return {
          closed: closedPromise,
          claimed: new Promise<void>(() => {}),
          close,
        };
      },
    );
    await runtime.retry(id);
    const readyDeadline = Date.now() + 2000;
    while (
      Date.now() < readyDeadline &&
      (channels !== 2 ||
        (await runtime.view()).shares[0].local_status !== "live")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(channels, 2);
    assert.equal(runtime.activeCount(), 1);
    assert.equal((await runtime.view()).shares[0].local_status, "live");
    await runtime.action({
      id,
      version: 2,
      action: "extend",
      expires_at: new Date(Date.now() + 10000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 3200));
    assert.equal(
      runtime.activeCount(),
      1,
      "extension must replace original expiry timer",
    );
    assert.equal(closed, 0, "extension must preserve eligible streams");
    await runtime.action({ id, version: 3, action: "grants", grants: [] });
    assert.equal(channels, 2);
    assert.equal(closed, 0, "grant edit must preserve serving generation");
    const laterPage = await runtime.view({ offset: 20, query: "old" });
    assert.equal(laterPage.shares.length, 0);
    assert.equal(
      runtime.activeCount(),
      1,
      "An active share outside the displayed page remains supervised",
    );
    assert.equal(closed, 0);
    await runtime.retire();
    assert.equal(closed, 2);
    assert.equal(runtime.activeCount(), 0);
    assert.equal(stopped, 1);
    terminal = true;
    await assert.rejects(runtime.retry(id), /terminal/);
    assert.equal(channels, 2);
  } finally {
    await runtime?.retire();
    globalThis.fetch = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("grant PUT matches strict CP DTO and safe nested error codes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "PUT");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["expected_version", "grants"]);
    assert.deepEqual(body.grants, []);
    return new Response(
      JSON.stringify({
        error: { code: "beam_version_conflict", message: "internal detail" },
      }),
      { status: 409 },
    );
  };
  try {
    const api = new BeamApi({
      server: "https://cp.example",
      token: "tnx_secret",
      orgId: id,
      userId: id,
      expiresAt: share.expires_at,
      assertCurrent: () => {},
    });
    await assert.rejects(
      api.action({ id, version: 1, action: "grants", grants: [] }),
      (error) =>
        error instanceof Error && error.message === "beam_version_conflict",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("minimum desktop version rejects older clients and accepts compatible stable versions", () => {
  assert.doesNotThrow(() => requireBeamClientVersion("0.1.7", "0.1.7"));
  assert.doesNotThrow(() => requireBeamClientVersion("0.1.7", "0.2.0"));
  assert.throws(
    () => requireBeamClientVersion("0.1.8", "0.1.7"),
    /update_required/,
  );
  assert.throws(
    () => requireBeamClientVersion("v0.1.7", "0.1.7"),
    /protocol_unsupported/,
  );
});
test("grant impact and confirmed mutation match strict CP DTOs", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls++;
    if (String(url).endsWith("/grants/impact")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(body, { expected_version: 2, grants: [] });
      return new Response(
        JSON.stringify({
          share_version: 2,
          removed_grant_count: 1,
          affected_reviewer_count: 1,
          affected_reviewer_session_count: 2,
          requires_confirmation: true,
        }),
      );
    }
    assert.equal(init?.method, "PUT");
    assert.deepEqual(body, {
      expected_version: 2,
      grants: [],
      confirm_reviewer_removal: true,
    });
    return new Response(JSON.stringify(share));
  };
  try {
    const api = new BeamApi({
      server: "https://cp.example",
      token: "test-token",
      userId: id,
      orgId: id,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      assertCurrent: () => {},
    });
    const impact = await api.previewGrants({ id, version: 2, grants: [] });
    assert.equal(impact.requires_confirmation, true);
    await api.action({
      id,
      version: impact.share_version,
      action: "grants",
      grants: [],
      confirm_reviewer_removal: true,
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("true connector certificate deadline closes serving before share and credential expiry", async () => {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const current = { ...share, target: { ...share.target, port: address.port } };
  const original = globalThis.fetch;
  let closed = 0;
  globalThis.fetch = async (url) => {
    const route = String(url);
    if (route.endsWith("/policy"))
      return new Response(
        JSON.stringify({
          enabled: true,
          domain_ready: true,
          can_publish: true,
          max_duration_seconds: 7200,
        }),
      );
    if (route.endsWith("/audience"))
      return new Response(JSON.stringify({ users: [], groups: [] }));
    if (route.endsWith("/connector"))
      return new Response(
        JSON.stringify({
          share_version: 2,
          binding: {
            purpose: "beam_proxy",
            org_id: id,
            gateway_id: id,
            app_id: id,
            generation: id,
            revision: 1,
            digest: beamTargetDigest(current.target),
            hostname: share.hostname,
            authority_version: 1,
          },
          proxy_url: "https://proxy.example",
          ca_pem: "CA",
          certificate_pem: "CERT",
          certificate_expires_at: new Date(Date.now() + 500).toISOString(),
          expires_at: share.expires_at,
        }),
      );
    if (route.endsWith("/heartbeat"))
      return new Response(
        JSON.stringify({ ...current, version: 2, connectivity: "online" }),
      );
    return new Response(
      JSON.stringify({
        items: [current],
        server_time: new Date().toISOString(),
      }),
    );
  };
  const runtime = new BeamRuntime(
    async () => ({
      server: "https://cp.example",
      token: "test-token",
      orgId: id,
      userId: id,
      expiresAt: share.expires_at,
      assertCurrent: () => {},
    }),
    async (_options, signal) => {
      let end!: () => void;
      const finished = new Promise<void>((resolve) => {
        end = resolve;
      });
      let done = false;
      const close = () => {
        if (!done) {
          done = true;
          closed++;
          end();
        }
      };
      signal.addEventListener("abort", close, { once: true });
      return { closed: finished, claimed: new Promise<void>(() => {}), close };
    },
  );
  try {
    await runtime.retry(id);
    assert.equal(runtime.activeCount(), 1);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(runtime.activeCount(), 0);
    assert.equal(closed, 2);
  } finally {
    await runtime.retire();
    globalThis.fetch = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("inventory requests use bounded server paging/search and own detail preserves actor boundary", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url) => {
    const route = String(url);
    seen.push(route);
    if (route.endsWith("/policy"))
      return new Response(JSON.stringify({ max_duration_seconds: 7200 }));
    if (route.endsWith("/audience"))
      return new Response(JSON.stringify({ users: [], groups: [] }));
    if (route.endsWith(`/shares/${id}`))
      return new Response(
        JSON.stringify({ ...share, publisher_id: "foreign" }),
      );
    return new Response(
      JSON.stringify({
        items: [],
        limit: 20,
        offset: 40,
        quota: { active_shares: 3, max_shares: 5 },
        server_time: new Date().toISOString(),
      }),
    );
  };
  try {
    const api = new BeamApi({
      server: "https://cp.example",
      token: "test-token",
      orgId: id,
      userId: id,
      expiresAt: share.expires_at,
      assertCurrent: () => {},
    });
    const page = await api.view({ offset: 40, query: "checkout & cart" });
    assert.deepEqual(page.page, { offset: 40, limit: 20, has_next: false });
    assert.deepEqual(page.quota, { active_shares: 3, max_shares: 5 });
    assert.ok(
      seen.some((url) =>
        url.endsWith("/shares?limit=20&offset=40&q=checkout%20%26%20cart&scope=active&state=active&connectivity=online"),
      ),
    );
    await assert.rejects(api.view({ offset: -1 }), /inventory_invalid/);
    await assert.rejects(api.ownShare(id), /share_unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

 test("Beam routes preserve every destination and reject nested or remote targets", () => {
 const root={...share.target,routes:[{path_prefix:"/api",target:{...share.target,port:8080}},{path_prefix:"/api/v2",target:{...share.target,port:8081}}]};
 const checked=validateBeamTarget(root);
 assert.equal(checked.routes?.[0].target.port,8080);
 assert.throws(()=>validateBeamTarget({...root,routes:[{path_prefix:"/api",target:{...share.target,address:"10.0.0.1"}}]}));
 assert.throws(()=>validateBeamTarget({...root,routes:[{path_prefix:"/api/../admin",target:share.target}]}));
 assert.throws(()=>validateBeamTarget({...root,routes:[{path_prefix:"/api",target:root}]}));
 assert.throws(()=>validateBeamTarget({...root,routes:[...root.routes,root.routes[0]]}));
 });


test("reviewer inventory is grant-scoped, redacted and rechecks access before browser open", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  let granted = true;
  const row = {...share, publisher_id:"another-publisher", publisher_name:"Designer", connectivity:"online", can_open:true, target:{...share.target,ca_pem:"PRIVATE-CA"}, grants:[{subject_kind:"user",subject_id:"PRIVATE-ID"}], connector_token:"PRIVATE-TOKEN"};
  globalThis.fetch = async input => {
    const url=String(input); seen.push(url);
    if (url.includes("/shared?")) return new Response(JSON.stringify({items:[row],offset:0,limit:20,server_time:new Date().toISOString()}));
    return new Response(JSON.stringify({...row,can_open:granted}));
  };
  const runtime = new BeamRuntime(async()=>({server:"https://cp.example",token:"test-token",orgId:id,userId:id,expiresAt:share.expires_at,assertCurrent:()=>{}}));
  try {
    const view = await runtime.shared({query:"design & docs"});
    assert.equal(view.shares.length,1);
    assert.equal(view.shares[0].publisher_name,"Designer");
    assert.ok(seen[0].endsWith("/shared?limit=20&offset=0&q=design%20%26%20docs&scope=active&state=active&connectivity=online"));
    assert.doesNotMatch(JSON.stringify(view),/PRIVATE|target|grants|connector_token/);
    assert.equal(await runtime.sharedURL(id),"https://sample.beam.example/");
    granted=false;
    await assert.rejects(runtime.sharedURL(id),/shared_access_unavailable/);
    await assert.rejects(runtime.shared({offset:-1}),/inventory_invalid/);
    await assert.rejects(runtime.sharedURL("invalid"),/share_invalid/);
    assert.equal(runtime.activeCount(),0);
  } finally {globalThis.fetch=original;await runtime.retire();}
});

test("review notifications clear only on successful open, persist across restart and isolate account scope", async () => {
  const original = globalThis.fetch;
  const opened = new Set<string>();
  const persistence = {has: (key: string) => opened.has(key), mark: (key: string) => {opened.add(key);}};
  let userId = id, server = "https://cp.example", orgId = id, current = true, granted = true;
  const row = {...share, connectivity:"online", can_open:true};
  const context = async () => ({server,token:"test-token",orgId,userId,expiresAt:share.expires_at,assertCurrent:()=>{if (!current) throw Error("beam_session_changed");}});
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("/shared?")
    ? {items:[{...row,can_open:granted}],offset:0,limit:20,server_time:new Date().toISOString()}
    : {...row,can_open:granted}));
  const runtime = new BeamRuntime(context, undefined, persistence);
  try {
    assert.equal((await runtime.notifications()).shares.length,1);
    await assert.rejects(runtime.openShared(id,async()=>{throw Error("browser_failed");}),/browser_failed/);
    assert.equal((await runtime.notifications()).shares.length,1);
    granted = false;
    await assert.rejects(runtime.openShared(id,async()=>{assert.fail("must not open revoked app");}),/shared_access_unavailable/);
    assert.equal(opened.size,0);
    granted = true;
    await assert.rejects(runtime.openShared(id,async()=>{current=false;}),/session_changed/);
    current = true;
    assert.equal(opened.size,0);
    await runtime.openShared(id,async url=>{assert.equal(url,"https://sample.beam.example/");});
    assert.equal((await runtime.notifications()).shares.length,0);
    assert.equal((await runtime.shared()).shares.length,1);
    const restarted = new BeamRuntime(context,undefined,persistence);
    assert.equal((await restarted.notifications()).shares.length,0);
    userId = "another-user"; assert.equal((await runtime.notifications()).shares.length,1);
    userId = id; orgId = "another-org"; assert.equal((await runtime.notifications()).shares.length,1);
    orgId = id; server = "https://another-cp.example"; assert.equal((await runtime.notifications()).shares.length,1);
    assert.equal(runtime.activeCount(),0);
    assert.doesNotMatch([...opened].join(),/test-token|cp.example|sample.beam/);
  } finally {globalThis.fetch=original;await runtime.retire();}
});

test("notifications find unread apps beyond an already-opened first page", async () => {
  const original = globalThis.fetch;
  const seen = new Set<string>();
  const runtime = new BeamRuntime(async()=>({server:"https://cp.example",token:"test-token",orgId:id,userId:id,expiresAt:share.expires_at,assertCurrent:()=>{}}),undefined,{has:key=>seen.has(key),mark:key=>{seen.add(key);}});
  const first = Array.from({length:20},(_,index)=>({...share,id:`12345678-1234-4234-8234-${String(index).padStart(12,"0")}`,connectivity:"online",can_open:true}));
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/shared")) return new Response(JSON.stringify({items:url.searchParams.get("offset")==="0" ? first : [{...share,connectivity:"online",can_open:true}],offset:Number(url.searchParams.get("offset")),limit:20,server_time:new Date().toISOString()}));
    return new Response(JSON.stringify(first.find(item=>url.pathname.endsWith(item.id))));
  };
  try {
    for (const item of first) await runtime.openShared(item.id,async()=>{});
    assert.deepEqual((await runtime.notifications()).shares.map(item=>item.id),[id]);
  } finally {globalThis.fetch=original;await runtime.retire();}
});

test("access notices require a confirmed withdrawal, never offline, paused, stopped, expired or failed reads",async()=>{
  const original=globalThis.fetch;
  let mode="live", clock=Date.now(), current=true;
  const alerts:Array<{id:string;episode:string}>=[];
  const runtime=new BeamRuntime(async()=>({server:"https://cp.example",token:"test-token",orgId:id,userId:id,expiresAt:share.expires_at,assertCurrent:()=>{if(!current)throw Error("beam_session_changed");}}),undefined,undefined,(_context,item,episode)=>{alerts.push({id:item.id,episode});});
  globalThis.fetch=async input=>{
    if(String(input).includes("/shared?")) return new Response(JSON.stringify({items:mode==="live"?[{...share,connectivity:"online",can_open:true}]:[],offset:0,limit:20,server_time:new Date(clock).toISOString()}));
    if(mode==="denied") return new Response(JSON.stringify({error:{code:"not_found"}}),{status:404});
    if(mode==="failed") return new Response("unavailable",{status:503});
    return new Response(JSON.stringify({...share,state:mode==="paused"?"paused":mode==="stopped"?"stopped":"active",connectivity:mode==="offline"?"offline":"online",can_open:mode!=="offline"}));
  };
  try {
    await runtime.notifications();
    for(const state of ["offline","paused","failed","stopped"]) {mode=state;await runtime.notifications();assert.equal(alerts.length,0);}
    mode="live";await runtime.notifications();
    mode="denied";current=false;await assert.rejects(runtime.notifications(),/session_changed/);assert.equal(alerts.length,0);
    current=true;await runtime.notifications();assert.equal(alerts.length,1);
    await runtime.notifications();assert.equal(alerts.length,1);
    mode="live";await runtime.notifications();mode="denied";await runtime.notifications();assert.equal(alerts.length,2);
    assert.notEqual(alerts[0].episode,alerts[1].episode);
    mode="live";await runtime.notifications();clock=Date.parse(share.expires_at)+1;mode="denied";await runtime.notifications();assert.equal(alerts.length,2);
  } finally {globalThis.fetch=original;await runtime.retire();}
});
