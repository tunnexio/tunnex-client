import { fixtureViewer } from "./beamviewer";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBeamChannelPool,
  type BeamPoolStatus,
} from "../src/main/beamchannelpool";
import type { BeamBinding } from "../src/main/beamconnector";
import { BEAM_MAX_BODY } from "../src/main/beamlimits";
async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeout = 5000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(message);
}
test(
  "native slow reader applies backpressure and withdrawal releases every bounded pool slot",
  { timeout: 25000 },
  async (t) => {
    const binary = process.env.BEAM_SPIKE_BIN;
    assert.ok(binary, "Explicit real core fixture required");
    await access(binary);
    const directory = await mkdtemp(
      join(tmpdir(), "tunnex-beam-backpressure-"),
    );
    const child = spawn(binary, ["--fixture-dir", directory, "--ttl", "45s"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += String(chunk);
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    let slowReader: http.ClientRequest | undefined;
    t.after(async () => {
      slowReader?.destroy();
      run.abort();
      origin.closeAllConnections();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    });
    await until(async () => {
      assert.equal(child.exitCode, null, diagnostic);
      try {
        await access(join(directory, "metadata.json"));
        return true;
      } catch {
        return false;
      }
    }, "Fixture readiness");
    const metadata = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as {
      proxyUrl: string;
      viewerUrl: string;
      controlUrl: string;
      reviewToken: string;
      controlToken: string;
      binding: BeamBinding;
    };
    const viewer = fixtureViewer(await readFile(join(directory, "ca.pem"), "utf8"));
    const fetch = viewer.fetch;
    let writes = 0,
      blocked = 0,
      originClosed = false;
    const block = Buffer.alloc(16384, 65);
    const origin = http.createServer((req, res) => {
      if (req.url !== "/slow") {
        res.end("concurrent");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const produce = () => {
        while (!res.destroyed) {
          writes += block.length;
          if (!res.write(block)) {
            blocked++;
            res.once("drain", produce);
            return;
          }
        }
      };
      res.once("close", () => {
        originClosed = true;
      });
      produce();
    });
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const address = origin.address();
    assert.ok(address && typeof address !== "string");
    t.after(() => {
      origin.closeAllConnections();
      origin.close();
    });
    const run = new AbortController();
    let status: BeamPoolStatus = {
        connected: 0,
        active: 0,
        idle: 0,
        opening: 0,
      },
      maximum = 0;
    const pool = runBeamChannelPool(
      {
        proxyUrl: metadata.proxyUrl,
        binding: metadata.binding,
        target: { address: "127.0.0.1", port: address.port },
        identity: {
          ca: await readFile(join(directory, "ca.pem"), "utf8"),
          cert: await readFile(join(directory, "connector.pem"), "utf8"),
          key: await readFile(join(directory, "connector-key.pem"), "utf8"),
        },
      },
      run.signal,
      (next) => {
        status = next;
        maximum = Math.max(maximum, next.active + next.idle + next.opening);
      },
    );
    t.after(async () => {
      run.abort();
      await pool;
    });
    await until(() => status.idle >= 2, "Idle pool");
    const cookie = `beam_fixture_review=${metadata.reviewToken}`;
    const before = process.memoryUsage();
    const reader = viewer.get(metadata.viewerUrl + "/slow", {
      headers: { Cookie: cookie },
    });
    slowReader = reader;
    reader.on("error", () => {});
    t.after(() => reader.destroy());
    let response!: http.IncomingMessage;
    await new Promise<void>((resolve, reject) => {
      reader.once("response", (res) => {
        response = res;
        res.on("error", () => {});
        res.pause();
        assert.equal(res.statusCode, 200);
        resolve();
      });
      reader.once("error", reject);
    });
    await until(
      () => blocked > 0 && status.active === 1,
      "Slow request admission",
    );
    // A blocked reader must stop origin production, while leaving idle admission
    // available for an independent request. The producer reuses one fixed buffer.
    let plateau = 0;
    for (let i = 0; i < 20; i++) {
      const prior = writes;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (writes === prior) {
        plateau++;
        if (plateau >= 3) break;
      } else plateau = 0;
    }
    assert.ok(
      plateau >= 3,
      "Origin must stop producing when the reviewer stops reading",
    );
    assert.ok(
      writes < BEAM_MAX_BODY,
      "Slow reader must block before body limit exhaustion",
    );
    const concurrent = await fetch(metadata.viewerUrl, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(await concurrent.text(), "concurrent");
    const after = process.memoryUsage();
    const retainedDelta = after.external - before.external;
    assert.ok(
      retainedDelta < 32 * 1024 * 1024,
      `Streaming external-buffer delta ${retainedDelta}`,
    );
    const began = Date.now();
    const revoked = await fetch(metadata.controlUrl + "/revoke", {
      method: "POST",
      headers: { "X-Beam-Fixture-Control": metadata.controlToken },
    });
    assert.equal(revoked.status, 204);
    await until(
      () => originClosed && status.active === 0,
      "Slow origin/active slot not released after withdrawal",
      5000,
    );
    assert.ok(Date.now() - began < 5000);
    run.abort();
    await pool;
    assert.deepEqual(status, { connected: 0, idle: 0, active: 0, opening: 0 });
    response.resume();
    response.destroy();
    assert.ok(maximum <= 34);
    t.diagnostic(
      JSON.stringify({
        originBytesBeforeBackpressure: writes,
        externalBufferDelta: retainedDelta,
        maximumReservations: maximum,
        withdrawalMs: Date.now() - began,
      }),
    );
  },
);
