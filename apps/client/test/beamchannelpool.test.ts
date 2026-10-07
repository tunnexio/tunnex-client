import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBeamChannelPool,
  type BeamPoolStatus,
} from "../src/main/beamchannelpool";
import type { BeamChannelOptions } from "../src/main/beamconnector";
const options = {} as BeamChannelOptions;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
test("pool replaces claimed long channels, bounds 32 active plus two idle, and cancels all slots", async () => {
  const controller = new AbortController();
  const entries: Array<{
    claim: () => void;
    close: () => void;
    closed: boolean;
  }> = [];
  let peak = 0;
  let status: BeamPoolStatus = { active: 0, idle: 0, opening: 0, connected: 0 };
  const pool = runBeamChannelPool(
    options,
    controller.signal,
    (value) => {
      status = value;
      peak = Math.max(peak, value.active + value.idle + value.opening);
      assert.ok(value.active <= 32);
    },
    async () => {
      let claim!: () => void;
      let end!: () => void;
      const claimed = new Promise<void>((resolve) => {
        claim = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        end = resolve;
      });
      const entry = {
        claim,
        close: () => {
          entry.closed = true;
          end();
        },
        closed: false,
      };
      entries.push(entry);
      return { claimed, closed, close: entry.close };
    },
  );
  await settle();
  assert.equal(entries.length, 2);
  entries[0].claim();
  entries[1].claim();
  await settle();
  assert.equal(entries.length, 4);
  assert.equal(status.active, 2);
  assert.equal(status.idle, 2);
  for (let i = 2; i < 32; i++) {
    entries[i].claim();
    await settle();
  }
  assert.equal(status.active, 32);
  assert.equal(entries.length, 34);
  assert.equal(status.idle, 2);
  assert.equal(peak, 34);
  entries[32].claim();
  await settle();
  assert.equal(entries[32].closed, true);
  assert.equal(status.active, 32);
  assert.equal(peak, 34);
  controller.abort();
  await pool;
  assert.equal(status.connected, 0);
  assert.equal(status.active, 0);
  assert.equal(status.opening, 0);
  assert.ok(entries.every((entry) => entry.closed));
});
test("failed dial retains only two backoff reservations and abort ends them without retry flood", async () => {
  const controller = new AbortController();
  let dials = 0;
  let final: BeamPoolStatus | undefined;
  const pool = runBeamChannelPool(
    options,
    controller.signal,
    (status) => {
      final = status;
    },
    async () => {
      dials++;
      throw new Error("offline");
    },
  );
  await settle();
  assert.equal(dials, 2);
  assert.equal(final?.opening, 2);
  controller.abort();
  await pool;
  assert.equal(dials, 2);
  assert.equal(final?.opening, 0);
});
