import { test } from "node:test";
import assert from "node:assert/strict";
import { finished } from "node:stream/promises";
import { BeamWebSocketValidator } from "../src/main/beamwebsocket";
import {
  BEAM_MAX_BODY,
  BEAM_MAX_WEBSOCKET_FRAME,
  BEAM_MAX_WEBSOCKET_FRAGMENTS,
} from "../src/main/beamlimits";

function header(
  opcode: number,
  length: number,
  masked: boolean,
  fin = true,
): Buffer {
  const extra = length < 126 ? 0 : length <= 65535 ? 2 : 8;
  const result = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  result[0] = opcode | (fin ? 128 : 0);
  result[1] =
    (masked ? 128 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) result.writeUInt16BE(length, 2);
  if (extra === 8) result.writeBigUInt64BE(BigInt(length), 2);
  return result;
}
async function rejected(
  bytes: Buffer,
  direction: "client" | "origin",
  reason: RegExp,
): Promise<void> {
  const validator = new BeamWebSocketValidator(direction);
  validator.resume();
  const done = finished(validator);
  validator.end(bytes);
  await assert.rejects(done, reason);
}

test("WebSocket headers survive every chunk boundary and preserve fragments/control bytes", async () => {
  for (const direction of ["client", "origin"] as const) {
    const masked = direction === "client";
    const bytes = Buffer.concat([
      header(2, 130, masked, false),
      Buffer.alloc(130, 71),
      header(9, 3, masked),
      Buffer.from("abc"),
      header(10, 0, masked),
      header(0, 5, masked),
      Buffer.from("final"),
      header(8, 0, masked),
    ]);
    for (let boundary = 1; boundary < 16; boundary++) {
      const validator = new BeamWebSocketValidator(direction);
      const output: Buffer[] = [];
      validator.on("data", (chunk) => output.push(chunk));
      const done = finished(validator);
      for (let start = 0; start < bytes.length; start += boundary)
        validator.write(bytes.subarray(start, start + boundary));
      validator.end();
      await done;
      assert.deepEqual(Buffer.concat(output), bytes);
    }
  }
});

test("payload streams before a frame completes; only its bounded header waits for validation", async () => {
  const validator = new BeamWebSocketValidator("client");
  let received = 0;
  validator.on("data", (chunk) => {
    received += chunk.length;
  });
  const done = finished(validator);
  const frame = header(2, BEAM_MAX_WEBSOCKET_FRAME, true);
  validator.write(frame.subarray(0, 13));
  assert.equal(received, 0, "unvalidated split header must not pass");
  validator.write(frame.subarray(13));
  const chunk = Buffer.alloc(4096);
  validator.write(chunk);
  assert.equal(
    received,
    frame.length + chunk.length,
    "must not buffer the 1MiB payload",
  );
  for (
    let offset = chunk.length;
    offset < BEAM_MAX_WEBSOCKET_FRAME;
    offset += chunk.length
  )
    validator.write(chunk);
  validator.end();
  await done;
  assert.equal(received, frame.length + BEAM_MAX_WEBSOCKET_FRAME);
});

test("both directions reject frame limits and RFC mask/opcode/control/length violations", async () => {
  for (const direction of ["client", "origin"] as const) {
    const masked = direction === "client";
    await rejected(
      header(2, BEAM_MAX_WEBSOCKET_FRAME + 1, masked),
      direction,
      /frame_limit/,
    );
    await rejected(header(1, 0, !masked), direction, /protocol/);
    await rejected(header(3, 0, masked), direction, /protocol/);
    await rejected(header(0, 0, masked), direction, /protocol/);
    await rejected(header(9, 0, masked, false), direction, /protocol/);
    await rejected(header(10, 126, masked), direction, /protocol/);
    await rejected(header(8, 1, masked), direction, /protocol/);
    const reserved = header(1, 0, masked);
    reserved[0] |= 64;
    await rejected(reserved, direction, /protocol/);
    const short126 = header(2, 126, masked);
    short126.writeUInt16BE(1, 2);
    await rejected(short126, direction, /protocol/);
    const short127 = header(2, 65536, masked);
    short127.writeBigUInt64BE(65535n, 2);
    await rejected(short127, direction, /protocol/);
    const highBit = header(2, 65536, masked);
    highBit.writeBigUInt64BE(1n << 63n, 2);
    await rejected(highBit, direction, /protocol/);
    await rejected(
      Buffer.concat([header(1, 0, masked, false), header(2, 0, masked)]),
      direction,
      /protocol/,
    );
    await rejected(header(2, 5, masked), direction, /truncated/);
  }
});

test("fragmented message is capped at the HTTP 16MiB budget without payload accumulation", async () => {
  for (const direction of ["client", "origin"] as const) {
    const masked = direction === "client";
    const validator = new BeamWebSocketValidator(direction);
    let bytes = 0;
    validator.on("data", (chunk) => {
      bytes += chunk.length;
    });
    const done = finished(validator);
    const chunk = Buffer.alloc(4096);
    for (
      let frame = 0;
      frame < BEAM_MAX_BODY / BEAM_MAX_WEBSOCKET_FRAME;
      frame++
    ) {
      validator.write(
        header(frame === 0 ? 2 : 0, BEAM_MAX_WEBSOCKET_FRAME, masked, false),
      );
      for (let n = 0; n < BEAM_MAX_WEBSOCKET_FRAME / chunk.length; n++)
        validator.write(chunk);
    }
    assert.ok(bytes >= BEAM_MAX_BODY);
    validator.end(header(0, 1, masked));
    await assert.rejects(done, /message_limit/);
  }
});

test("empty fragments cannot evade the bounded fragment count", async () => {
  const validator = new BeamWebSocketValidator("origin");
  validator.resume();
  const done = finished(validator);
  for (let n = 0; n < BEAM_MAX_WEBSOCKET_FRAGMENTS; n++)
    validator.write(header(n === 0 ? 1 : 0, 0, false, false));
  validator.end(header(0, 0, false));
  await assert.rejects(done, /fragment_limit/);
});
