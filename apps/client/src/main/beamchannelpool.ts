import { setMaxListeners } from "node:events";
import {
  openBeamChannel,
  type BeamChannelOptions,
  type BeamChannel,
} from "./beamconnector";

export interface BeamPoolStatus {
  connected: number;
  idle: number;
  active: number;
  opening: number;
}
// CONNECT is single-use. Replenish after claim, including long SSE/HMR requests.
// Synchronous reservations prevent competing callbacks from exceeding the cap.
export async function runBeamChannelPool(
  options: BeamChannelOptions,
  signal: AbortSignal,
  changed: (status: BeamPoolStatus) => void = () => {},
  connect: (
    options: BeamChannelOptions,
    signal: AbortSignal,
  ) => Promise<BeamChannel> = openBeamChannel,
): Promise<void> {
  setMaxListeners(64, signal);
  const channels = new Set<BeamChannel>();
  let idle = 0,
    active = 0,
    opening = 0,
    tasks = 0;
  let done!: () => void;
  const completed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const publish = () =>
    changed({ connected: channels.size, idle, active, opening });
  const finish = () => {
    if (signal.aborted && tasks === 0) {
      signal.removeEventListener("abort", abort);
      done();
    }
  };
  const abort = () => {
    for (const channel of channels) channel.close();
    finish();
  };
  signal.addEventListener("abort", abort, { once: true });
  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        resolve();
      };
      const timer = setTimeout(end, milliseconds);
      signal.addEventListener("abort", end, { once: true });
      if (signal.aborted) end();
    });
  const fill = () => {
    while (
      !signal.aborted &&
      idle + opening < 2 &&
      active + idle + opening < 34
    ) {
      opening++;
      tasks++;
      publish();
      void serve();
    }
    finish();
  };
  const serve = async () => {
    let channel: BeamChannel | undefined;
    let reservation: "opening" | "idle" | "active" | "none" = "opening";
    let retry = 300;
    try {
      // The two opening reservations include backoff, so failure cannot fan out.
      while (!signal.aborted) {
        try {
          channel = await connect(options, signal);
          break;
        } catch {
          await wait(retry + Math.floor(Math.random() * Math.min(retry, 300)));
          retry = Math.min(10_000, retry * 2);
        }
      }
      opening--;
      reservation = "none";
      if (!channel) return;
      if (signal.aborted) {
        channel.close();
        await channel.closed;
        return;
      }
      channels.add(channel);
      idle++;
      reservation = "idle";
      publish();
      const claimed = await Promise.race([
        channel.claimed.then(() => true),
        channel.closed.then(() => false),
      ]);
      if (claimed && !signal.aborted) {
        idle--;
        reservation = "none";
        if (active >= 32) {
          channel.close();
          await channel.closed;
          await wait(300);
          return;
        }
        active++;
        reservation = "active";
        publish();
        fill();
        await channel.closed;
      } else if (!signal.aborted) await wait(300);
    } finally {
      if (reservation === "opening") opening--;
      if (reservation === "idle") idle--;
      if (reservation === "active") active--;
      if (channel) channels.delete(channel);
      tasks--;
      publish();
      fill();
    }
  };
  fill();
  if (signal.aborted) abort();
  await completed;
}
