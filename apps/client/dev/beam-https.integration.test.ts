import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as https from "node:https";
import type { Duplex } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBeamChannelPool } from "../src/main/beamchannelpool";
import { checkBeamTarget } from "../src/main/beamruntime";
import type { BeamBinding } from "../src/main/beamconnector";
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(message);
}
test(
  "native verified HTTPS binds HTTP and WebSocket identity to loopback despite public Host",
  { timeout: 20000 },
  async (t) => {
    const binary = process.env.BEAM_SPIKE_BIN;
    assert.ok(binary, "Explicit real core fixture required");
    await access(binary);
    const directory = await mkdtemp(join(tmpdir(), "tunnex-beam-https-"));
    const child = spawn(binary, ["--fixture-dir", directory, "--ttl", "45s"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.on("data", (b) => {
      diagnostic += String(b);
    });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const ownedSockets = new Set<Duplex>();
    const aborts: AbortController[] = [];
    const servers: https.Server[] = [];
    t.after(async () => {
      for (const abort of aborts) abort.abort();
      for (const socket of ownedSockets) socket.destroy();
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      child.kill("SIGTERM");
      await exited;
    });
    await until(async () => {
      assert.equal(child.exitCode, null, diagnostic);
      try {
        await access(join(directory, "metadata.json"));
        return true;
      } catch {
        return false;
      }
    }, "TLS fixture readiness");
    const meta = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as {
      proxyUrl: string;
      viewerUrl: string;
      reviewToken: string;
      binding: BeamBinding;
    };
    const identity = {
      ca: await readFile(join(directory, "ca.pem"), "utf8"),
      cert: await readFile(join(directory, "connector.pem"), "utf8"),
      key: await readFile(join(directory, "connector-key.pem"), "utf8"),
    };
    const cookie = `beam_fixture_review=${meta.reviewToken}`;
    for (const valid of [true, false]) {
      const stem = join(directory, valid ? "loopback" : "wrong-name");
      const config = stem + ".cnf";
      await writeFile(
        config,
        `[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=loopback fixture\n[extensions]\nsubjectAltName=${valid ? "IP:127.0.0.1" : "DNS:wrong.local"}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
      );
      await promisify(execFile)(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-config",
          config,
          "-keyout",
          stem + ".key",
          "-out",
          stem + ".pem",
        ],
        { timeout: 5000 },
      );
      const cert = await readFile(stem + ".pem", "utf8");
      let requests = 0,
        upgrades = 0;
      const origin = https.createServer(
        { cert, key: await readFile(stem + ".key", "utf8") },
        (req, res) => {
          requests++;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ host: req.headers.host }));
        },
      );
      servers.push(origin);
      origin.on("connection", (socket) => {
        ownedSockets.add(socket);
        socket.once("close", () => ownedSockets.delete(socket));
      });
      origin.on("upgrade", (req, socket) => {
        upgrades++;
        const accept = createHash("sha1")
          .update(
            String(req.headers["sec-websocket-key"]) +
              "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
          )
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
        );
        socket.write(
          Buffer.concat([Buffer.from([0x81, 6]), Buffer.from("secure")]),
        );
      });
      await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
      const address = origin.address();
      assert.ok(address && typeof address !== "string");
      const target = {
        address: "127.0.0.1" as const,
        port: address.port,
        protocol: "https" as const,
        ca_pem: cert,
      };
      assert.equal((await checkBeamTarget(target)).ready, valid);
      const abort = new AbortController();
      aborts.push(abort);
      let idle = 0;
      const pool = runBeamChannelPool(
        { proxyUrl: meta.proxyUrl, binding: meta.binding, target, identity },
        abort.signal,
        (s) => {
          idle = s.idle;
        },
      );
      await until(() => idle >= 2, "HTTPS pool idle");
      const before = requests;
      const response = await fetch(meta.viewerUrl, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(3000),
      });
      if (valid) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          host: meta.binding.hostname,
        });
      } else {
        assert.equal(response.status, 502);
        await response.text();
        assert.equal(requests, before);
      }
      await until(() => idle >= 2, "HTTPS pool refill");
      const request = http.request(meta.viewerUrl + "/hmr", {
        headers: {
          Cookie: cookie,
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: meta.viewerUrl,
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "vite-hmr",
        },
      });
      request.on("error", () => {});
      const upgraded = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("HTTPS upgrade timeout")),
          3000,
        );
        request.once("response", (res) => {
          clearTimeout(timer);
          res.resume();
          resolve(false);
        });
        request.once("upgrade", (res, socket, head) => {
          clearTimeout(timer);
          ownedSockets.add(socket);
          socket.once("close", () => ownedSockets.delete(socket));
          assert.equal(res.headers["sec-websocket-protocol"], "vite-hmr");
          const finish = (data: Buffer) => {
            assert.equal(data.subarray(2).toString(), "secure");
            socket.destroy();
            resolve(true);
          };
          if (head.length) finish(head);
          else socket.once("data", finish);
        });
        request.end();
      });
      assert.equal(upgraded, valid);
      assert.equal(upgrades, valid ? 1 : 0);
      abort.abort();
      await pool;
    }
  },
);
