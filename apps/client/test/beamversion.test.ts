import {beamTargetDigest} from "../src/main/beamroutes";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BeamRuntime } from "../src/main/beamruntime";
import type { BeamShare } from "../src/main/beamtypes";

const id = "12345678-1234-4234-8234-123456789abc";

test("bootstrap version authorizes immediate pause, stop and quit before heartbeat completes", async () => {
  const server = http.createServer((_request, response) => response.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const original = globalThis.fetch;
  try {
    for (const action of ["pause", "stop", "quit"] as const) {
      const share: BeamShare = {
        id,
        publisher_id: id,
        created_at: new Date().toISOString(),
        name: "Preview",
        hostname: "example.beam.test",
        url: "https://example.beam.test",
        target: {
          protocol: "http" as const,
          address: "127.0.0.1" as const,
          port: address.port,
        },
        state: "starting" as const,
        version: 4,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        grants: [],
      };
      let releaseHeartbeat!: () => void;
      const pending = new Promise<Response>((resolve) => {
        releaseHeartbeat = () => resolve(new Response(JSON.stringify(share)));
      });
      let transitions = 0;
      globalThis.fetch = async (url, init) => {
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
              share_version: 5,
              binding: {
                purpose: "beam_proxy",
                org_id: id,
                gateway_id: id,
                app_id: id,
                generation: id,
                revision: 1,
                digest: beamTargetDigest(share.target),
                hostname: share.hostname,
                authority_version: 1,
              },
              proxy_url: "https://proxy.test",
              ca_pem: "CA",
              certificate_pem: "CERT",
              certificate_expires_at: share.expires_at,
              expires_at: share.expires_at,
            }),
          );
        if (route.endsWith("/heartbeat")) return pending;
        if (route.endsWith("/actions")) {
          const body = JSON.parse(String(init?.body));
          assert.equal(
            body.expected_version,
            5,
            "must use persisted post-bootstrap version",
          );
          assert.equal(body.action, action === "quit" ? "stop" : action);
          transitions++;
          return new Response(
            JSON.stringify({ ...share, version: 6, state: "paused" }),
          );
        }
        // A response already in flight may still carry the pre-bootstrap version.
        return new Response(
          JSON.stringify({
            items: [share],
            server_time: new Date().toISOString(),
          }),
        );
      };
      const runtime = new BeamRuntime(
        async () => ({
          server: "https://cp.test",
          token: "test-token",
          userId: id,
          orgId: id,
          expiresAt: share.expires_at,
          assertCurrent: () => {},
        }),
        async (_options, signal) => {
          let close!: () => void;
          const closed = new Promise<void>((resolve) => {
            close = resolve;
          });
          signal.addEventListener("abort", close, { once: true });
          return { closed, claimed: new Promise<void>(() => {}), close };
        },
      );
      try {
        await runtime.retry(id);
        const view = await runtime.view();
        assert.equal(view.shares[0].version, 5);
        if (action === "quit") await runtime.retire();
        else
          await runtime.action({ id, version: view.shares[0].version, action });
        assert.equal(transitions, 1);
        assert.equal(runtime.activeCount(), 0);
      } finally {
        releaseHeartbeat();
        await runtime.retire();
      }
    }
  } finally {
    globalThis.fetch = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
