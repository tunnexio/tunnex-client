import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBeamChannelPool } from "../src/main/beamchannelpool";
import {
  openBeamChannel,
  beamBindingHeaders,
  type BeamBinding,
  type BeamChannelOptions,
} from "../src/main/beamconnector";
import {
  BEAM_MAX_BODY,
  BEAM_MAX_WEBSOCKET_FRAME,
} from "../src/main/beamlimits";

function frameHeader(
  opcode: number,
  length: number,
  masked: boolean,
  fin = true,
): Buffer {
  const extra = length < 126 ? 0 : length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = (fin ? 128 : 0) | opcode;
  header[1] =
    (masked ? 128 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}
function frame(
  opcode: number,
  text: string,
  masked = false,
  fin = true,
): Buffer {
  // Fixed zero mask is legal; this makes expected wire bytes deterministic.
  return Buffer.concat([
    frameHeader(opcode, Buffer.byteLength(text), masked, fin),
    Buffer.from(text),
  ]);
}
async function until(
  check: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}
function closedWithin(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timeout = setTimeout(
      () =>
        reject(
          Error("WebSocket bound did not close traffic within two seconds"),
        ),
      2000,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

test(
  "real native WebSocket enforces both directional frame/message bounds without breaking fragments/control/HMR",
  { timeout: 35000 },
  async (t) => {
    const binary = process.env.BEAM_SPIKE_BIN;
    assert.ok(
      binary,
      "BEAM_SPIKE_BIN must name the real Go transport fixture; never skip qualification",
    );
    await access(binary);
    const directory = await mkdtemp(join(tmpdir(), "tunnex-beam-websocket-"));
    const core = spawn(binary, ["--fixture-dir", directory, "--ttl", "1m"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let fixtureError = "";
    core.stderr.on("data", (chunk) => {
      fixtureError += String(chunk);
    });
    const exited = new Promise<void>((resolve) =>
      core.once("exit", () => resolve()),
    );
    const controller = new AbortController();
    let pool: Promise<void> | undefined;
    const sockets = new Set<net.Socket>();
    let oversizedOriginRequests = 0;
    const origin = http.createServer((request, response) => {
      if (request.url === "/oversized-header") oversizedOriginRequests++;
      response.end("origin ready");
    });
    const expectedClient = Buffer.concat([
      frame(1, "client-", true, false),
      frame(9, "p", true),
      frame(0, "fragments", true),
    ]);
    let extensionRequests = 0;
    const received = new Map<string, number>();
    const servedUpgrades = new Set<string>();
    origin.on("upgrade", (request, socket, head) => {
      const peer = socket as net.Socket;
      sockets.add(peer);
      peer.on("error", () => {});
      peer.once("close", () => sockets.delete(peer));
      assert.equal(
        request.headers["sec-websocket-extensions"],
        undefined,
        "compression offer must be stripped before origin",
      );
      assert.equal(request.headers["sec-websocket-protocol"], "vite-hmr");
      extensionRequests++;
      const route = request.url!;
      servedUpgrades.add(route);
      const accept = createHash("sha1")
        .update(
          String(request.headers["sec-websocket-key"]) +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      const response = Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n${route === "/extensions" ? "Sec-WebSocket-Extensions: permessage-deflate\r\n" : ""}\r\n`,
      );
      const initial =
        route === "/origin-large"
          ? frameHeader(2, BEAM_MAX_WEBSOCKET_FRAME + 1, false)
          : route === "/origin-mask"
            ? frame(1, "wrong mask", true)
            : route === "/normal"
              ? Buffer.concat([
                  frame(1, "h", false, false),
                  frame(9, "ping"),
                  frame(0, "mr"),
                ])
              : Buffer.alloc(0);
      // Coalesced origin upgrade head must traverse the same validator as later data.
      peer.write(Buffer.concat([response, initial]));
      let small = Buffer.alloc(0);
      const data = (chunk: Buffer) => {
        received.set(route, (received.get(route) || 0) + chunk.length);
        if (route !== "/normal") return;
        small = Buffer.concat([small, chunk]);
        assert.ok(
          small.length <= expectedClient.length,
          "normal test origin only buffers its tiny expected handshake frames",
        );
        if (small.length === expectedClient.length) {
          assert.deepEqual(small, expectedClient);
          peer.write(frame(1, "client-fragments-ok"));
        }
      };
      peer.on("data", data);
      if (head.length) data(head);
    });
    t.after(async () => {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      if (pool) await pool;
      origin.closeAllConnections();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
      core.kill("SIGTERM");
      await exited;
    });
    await until(async () => {
      assert.equal(core.exitCode, null, fixtureError || "Go fixture exited");
      try {
        await access(join(directory, "metadata.json"));
        return true;
      } catch {
        return false;
      }
    }, "Go fixture not ready");
    const metadata = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as {
      proxyUrl: string;
      viewerUrl: string;
      controlUrl: string;
      reviewToken: string;
      binding: BeamBinding;
    };
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const address = origin.address();
    assert.ok(address && typeof address !== "string");
    const options: BeamChannelOptions = {
      proxyUrl: metadata.proxyUrl,
      binding: metadata.binding,
      target: { address: "127.0.0.1", port: address.port },
      identity: {
        ca: await readFile(join(directory, "ca.pem"), "utf8"),
        cert: await readFile(join(directory, "connector.pem"), "utf8"),
        key: await readFile(join(directory, "connector-key.pem"), "utf8"),
      },
    };
    pool = runBeamChannelPool(options, controller.signal);
    await until(
      async () =>
        (
          (await fetch(metadata.controlUrl + "/status").then((response) =>
            response.json(),
          )) as { capacity: { Ready: number } }
        ).capacity.Ready >= 2,
      "Native pool not ready",
    );
    async function upgrade(
      route: string,
    ): Promise<{ socket: net.Socket; head: Buffer }> {
      await until(
        async () =>
          (
            (await fetch(metadata.controlUrl + "/status").then((response) =>
              response.json(),
            )) as { capacity: { Ready: number } }
          ).capacity.Ready >= 1,
        "Replacement native channel not ready",
      );
      return new Promise((resolve, reject) => {
        const request = http.request(metadata.viewerUrl + route, {
          headers: {
            Cookie: `beam_fixture_review=${metadata.reviewToken}`,
            Origin: metadata.viewerUrl,
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
            "Sec-WebSocket-Protocol": "vite-hmr",
            "Sec-WebSocket-Extensions":
              "permessage-deflate; client_max_window_bits",
          },
        });
        request.once("error", reject);
        request.once("response", (response) => {
          response.resume();
          reject(Error(`Upgrade ${route} HTTP ${response.statusCode}`));
        });
        request.once("upgrade", (response, socket, head) => {
          assert.equal(response.headers["sec-websocket-protocol"], "vite-hmr");
          assert.equal(response.headers["sec-websocket-extensions"], undefined);
          sockets.add(socket);
          socket.on("error", () => {});
          socket.once("close", () => sockets.delete(socket));
          resolve({ socket, head });
        });
        request.end();
      });
    }
    const normal = await upgrade("/normal");
    const seen: string[] = [];
    let buffered = Buffer.alloc(0),
      message = "",
      sawPing = false;
    const parseSmall = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (
        buffered.length >= 2 &&
        buffered.length >= 2 + (buffered[1] & 127)
      ) {
        assert.equal(buffered[1] & 128, 0);
        assert.ok((buffered[1] & 127) <= 125);
        const length = buffered[1] & 127,
          opcode = buffered[0] & 15;
        const payload = buffered.subarray(2, 2 + length).toString();
        if (opcode === 9) sawPing = payload === "ping";
        else {
          if (opcode === 1) message = "";
          message += payload;
          if (buffered[0] & 128) seen.push(message);
        }
        buffered = buffered.subarray(2 + length);
      }
    };
    normal.socket.on("data", parseSmall);
    if (normal.head.length) parseSmall(normal.head);
    // Bytewise client headers exercise live chunk-boundary handling.
    for (const byte of expectedClient) normal.socket.write(Buffer.from([byte]));
    await until(
      async () =>
        sawPing && seen.includes("hmr") && seen.includes("client-fragments-ok"),
      "Fragmented messages/control ping did not traverse both directions",
    );
    normal.socket.destroy();
    for (const route of ["/origin-large", "/origin-mask"]) {
      const began = Date.now();
      const connection = await upgrade(route).catch((error) => {
        // Rejecting a coalesced originHead may close before the proxy can forward
        // 101. Its 503/EOF is valid only if this exact origin upgrade was admitted.
        assert.ok(
          servedUpgrades.has(route),
          "must reach real origin before bound rejection",
        );
        assert.match(String(error), /HTTP 503|socket hang up/);
        return undefined;
      });
      if (connection) await closedWithin(connection.socket);
      assert.ok(
        Date.now() - began < 2000,
        "origin frame rejection must promptly close",
      );
    }
    for (const [route, bad] of [
      ["/client-large", frameHeader(2, BEAM_MAX_WEBSOCKET_FRAME + 1, true)],
      ["/client-mask", frame(1, "missing mask", false)],
    ] as const) {
      const connection = await upgrade(route),
        closed = closedWithin(connection.socket);
      connection.socket.write(bad);
      await closed;
      assert.equal(
        received.get(route) || 0,
        0,
        "invalid client frame must not pass its header to the origin",
      );
    }
    // A reviewer must wait for 101; Go's public ReverseProxy buffers premature
    // browser bytes. Drive the native admission socket directly to guarantee a
    // nonempty client upgrade head, using an explicit private local TLS fixture.
    const config = join(directory, "native-head-tls.cnf");
    const certPath = join(directory, "native-head-cert.pem"),
      keyPath = join(directory, "native-head-key.pem");
    await writeFile(
      config,
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Beam native head test\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\n",
    );
    execFileSync(
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
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(certPath, "utf8"),
      key = await readFile(keyPath, "utf8");
    let bodyAdmission = false,
      bodyResponse = "";
    const admission = tls.createServer(
      {
        cert,
        key,
        ca: cert,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      },
      (peer) => {
        sockets.add(peer);
        peer.on("error", () => {});
        peer.once("close", () => sockets.delete(peer));
        let headers = Buffer.alloc(0);
        const connect = (chunk: Buffer) => {
          headers = Buffer.concat([headers, chunk]);
          assert.ok(headers.length <= 32768);
          if (!headers.includes("\r\n\r\n")) return;
          assert.match(
            headers.toString(),
            /^CONNECT \/beam\/channel HTTP\/1\.1/,
          );
          peer.off("data", connect);
          if (bodyAdmission) {
            peer.on("data", (chunk) => {
              bodyResponse += chunk.toString();
              assert.ok(bodyResponse.length <= 4096);
            });
            const authority = Object.entries(
              beamBindingHeaders(metadata.binding),
            )
              .map(([name, value]) => `${name}: ${value}\r\n`)
              .join("");
            peer.write(
              `HTTP/1.1 200 Connection established\r\n\r\nPOST /oversized-header HTTP/1.1\r\nHost: ${metadata.binding.hostname}\r\nX-App-Stream-ID: native-body\r\n${authority}Content-Length: ${(16 << 20) + 1}\r\n\r\nx`,
            );
            return;
          }
          const injected = Buffer.from(
            `GET /client-head-mask HTTP/1.1\r\nHost: ${metadata.binding.hostname}\r\nOrigin: https://${metadata.binding.hostname}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\nX-App-Stream-ID: native-head\r\n${Object.entries(
              beamBindingHeaders(metadata.binding),
            )
              .map(([name, value]) => `${name}: ${value}\r\n`)
              .join("")}\r\n`,
          );
          peer.write(
            Buffer.concat([
              Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n"),
              injected,
              frame(1, "client upgrade head must be masked", false),
            ]),
          );
        };
        peer.on("data", connect);
        peer.resume();
      },
    );
    await new Promise<void>((resolve) =>
      admission.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => admission.close(() => resolve())),
    );
    const admissionAddress = admission.address();
    assert.ok(admissionAddress && typeof admissionAddress !== "string");
    const nativeHead = await openBeamChannel(
      {
        ...options,
        proxyUrl: `https://127.0.0.1:${admissionAddress.port}`,
        identity: { cert, key, ca: cert },
      },
      controller.signal,
    );
    await Promise.race([
      nativeHead.closed,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(Error("Native client upgrade head bypassed validation")),
          2000,
        ),
      ),
    ]);
    assert.ok(servedUpgrades.has("/client-head-mask"));
    assert.equal(
      received.get("/client-head-mask") || 0,
      0,
      "coalesced native client upgrade head must not bypass validation",
    );
    // The public ingress rejects oversize first. A separate mutually verified
    // native admission fixture exercises the connector's own independent bound.
    bodyAdmission = true;
    const nativeBody = await openBeamChannel(
      {
        ...options,
        proxyUrl: `https://127.0.0.1:${admissionAddress.port}`,
        identity: { cert, key, ca: cert },
      },
      controller.signal,
    );
    await Promise.race([
      nativeBody.closed,
      new Promise<never>((_r, reject) =>
        setTimeout(
          () => reject(Error("Native oversize header waited for request body")),
          2000,
        ),
      ),
    ]);
    assert.match(bodyResponse, /^HTTP\/1\.1 413 /);
    assert.equal(
      oversizedOriginRequests,
      0,
      "Oversize declared body must never reach origin",
    );

    const fragmented = await upgrade("/client-message");
    const chunk = Buffer.alloc(4096);
    const write = async (bytes: Buffer) => {
      if (!fragmented.socket.write(bytes))
        await new Promise<void>((resolve, reject) => {
          const fail = () =>
            reject(Error("Message closed before valid 16MiB prefix completed"));
          fragmented.socket.once("close", fail);
          fragmented.socket.once("drain", () => {
            fragmented.socket.off("close", fail);
            resolve();
          });
        });
    };
    for (let n = 0; n < BEAM_MAX_BODY / BEAM_MAX_WEBSOCKET_FRAME; n++) {
      await write(
        frameHeader(n === 0 ? 2 : 0, BEAM_MAX_WEBSOCKET_FRAME, true, false),
      );
      for (
        let bytes = 0;
        bytes < BEAM_MAX_WEBSOCKET_FRAME;
        bytes += chunk.length
      )
        await write(chunk);
    }
    const fragmentedClosed = closedWithin(fragmented.socket);
    fragmented.socket.write(frameHeader(0, 1, true));
    await fragmentedClosed;
    const extension = await upgrade("/extensions").catch(() => undefined);
    if (extension) await closedWithin(extension.socket);
    assert.ok(
      servedUpgrades.has("/extensions"),
      "unexpected origin extension must be tested after admission",
    );
    assert.ok(extensionRequests >= 7);
    const stillReady = await fetch(metadata.viewerUrl, {
      headers: { Cookie: `beam_fixture_review=${metadata.reviewToken}` },
    });
    assert.equal(stillReady.status, 200);
    await stillReady.text();
  },
);
