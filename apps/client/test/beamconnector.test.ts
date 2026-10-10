import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBeamChannel, type BeamChannelOptions } from "../src/main/beamconnector";

function options(): BeamChannelOptions {
  return {
    proxyUrl: "https://proxy.example",
    binding: { orgId: "10000000-0000-4000-8000-000000000001", connectorId: "20000000-0000-4000-8000-000000000002", shareId: "30000000-0000-4000-8000-000000000003", generation: "40000000-0000-4000-8000-000000000004", revision: 1, authorityVersion: 1, targetDigest: "a".repeat(64), hostname: "p-example.beam.example" },
    target: { address: "127.0.0.1", port: 3000 },
    identity: { ca: "fixture", cert: "fixture", key: "fixture" },
  };
}

test("Beam refuses remote targets and unsafe port coercion before networking", () => {
  for (const address of ["localhost", "127.0.0.2", "10.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "0.0.0.0"]) {
    const value = options();
    value.target.address = address as "127.0.0.1";
    assert.throws(() => validateBeamChannel(value), /beam_target_invalid/);
  }
  for (const port of [0, 65536, NaN, 3.5, "3000"]) {
    const value = options();
    value.target.port = port as number;
    assert.throws(() => validateBeamChannel(value), /beam_target_invalid/);
  }
  const ipv6 = options();
  ipv6.target.address = "::1";
  assert.equal(validateBeamChannel(ipv6).origin, "https://proxy.example");
});

test("Beam refuses proxy URL credentials paths and HTTP downgrade", () => {
  for (const url of ["http://proxy.example", "https://user:secret@proxy.example", "https://proxy.example/override", "https://proxy.example?q=1", "https://proxy.example#part"]) {
    const value = options(); value.proxyUrl = url;
    assert.throws(() => validateBeamChannel(value), /beam_proxy_invalid/);
  }
});

test("Beam rejects incomplete identities and header injection", () => {
  for (const update of [
    { hostname: "p.example\r\nX-App-Org-ID: foreign" },
    { hostname: "*.example" },
    { orgId: "00000000-0000-0000-0000-000000000000" },
    { targetDigest: "not-a-digest" },
    { revision: 0 },
    { authorityVersion: 1.5 },
  ]) {
    const value = options(); Object.assign(value.binding, update);
    assert.throws(() => validateBeamChannel(value), /beam_binding_invalid/);
  }
  const value = options(); value.identity.key = "";
  assert.throws(() => validateBeamChannel(value), /beam_identity_missing/);
});

 test("Beam routes choose longest segment prefix and keep ordinary frontend routes", async () => {
 const {selectBeamTarget} = await import("../src/main/beamroutes");
 const root={address:"127.0.0.1" as const,protocol:"http" as const,port:3000,routes:[{path_prefix:"/api",target:{address:"127.0.0.1" as const,protocol:"http" as const,port:8080}},{path_prefix:"/api/v2",target:{address:"127.0.0.1" as const,protocol:"http" as const,port:8081}}]};
 assert.equal(selectBeamTarget(root,"/api/orders?next=https://remote").port,8080);
 assert.equal(selectBeamTarget(root,"/api/v2/orders").port,8081);
 assert.equal(selectBeamTarget(root,"/apiary").port,3000);
 assert.throws(()=>selectBeamTarget(root,"/api/../admin"));
 const value=options();value.target.routes=[{path_prefix:"/api",target:{...root,address:"169.254.169.254" as "127.0.0.1",routes:undefined}}];
 assert.throws(()=>validateBeamChannel(value),/beam_target_invalid/);
 });

 test("Beam digest includes API routes and matches control-plane JSON escaping", async () => {
 const {beamTargetDigest}=await import("../src/main/beamroutes");
 const root={address:"127.0.0.1" as const,protocol:"http" as const,port:3000};
 const routed={...root,routes:[{path_prefix:"/api",target:{...root,port:8080}}]};
 assert.notEqual(beamTargetDigest(root),beamTargetDigest(routed));
 assert.notEqual(beamTargetDigest(routed),beamTargetDigest({...routed,routes:[{path_prefix:"/api",target:{...root,port:8081}}]}));
 const {createHash}=await import("node:crypto");
 assert.equal(beamTargetDigest(root),createHash("sha256").update('{"protocol":"http","address":"127.0.0.1","port":3000}').digest("hex"));
 });
