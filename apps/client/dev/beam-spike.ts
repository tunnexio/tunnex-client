import { spawn } from "node:child_process";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBeamFixtureApp } from "./beamfixture";
import { runBeamFixturePool } from "./beampool";
import type { BeamBinding } from "../src/main/beamconnector";

async function main(): Promise<void> {
  const binary = process.env.BEAM_SPIKE_BIN;
  if (!binary) throw new Error("Set BEAM_SPIKE_BIN to the built core local fixture");
  await access(binary);
  const directory = await mkdtemp(join(tmpdir(), "tunnex-beam-demo-"));
  const child = spawn(binary, ["--fixture-dir", directory, "--ttl", "20m"], { stdio: ["ignore", "inherit", "inherit"] });
  const run = new AbortController();
  const exit = () => { run.abort(); child.kill("SIGTERM"); };
  process.once("SIGINT", exit); process.once("SIGTERM", exit);
  child.once("exit", () => run.abort());
  const deadline = Date.now() + 5000;
  while (true) {
    try { await access(join(directory, "metadata.json")); break; } catch {
      if (Date.now() >= deadline || child.exitCode !== null) { exit(); throw new Error("fixture failed to become ready"); }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as { proxyUrl: string; controlUrl: string; expiresAt: string; binding: BeamBinding };
  const expiryTimer = setTimeout(exit, Math.max(0, Date.parse(metadata.expiresAt) - Date.now()));
  const app = await startBeamFixtureApp();
  console.log(`Local Beam review dashboard: ${metadata.controlUrl}`);
  console.log("Development fixture only; account auth and public-domain setup are not connected.");
  try {
    await runBeamFixturePool({ proxyUrl: metadata.proxyUrl, binding: metadata.binding, target: { address: "127.0.0.1", port: app.port }, identity: {
      ca: await readFile(join(directory, "ca.pem"), "utf8"), cert: await readFile(join(directory, "connector.pem"), "utf8"), key: await readFile(join(directory, "connector-key.pem"), "utf8"),
    } }, run.signal);
  } finally { clearTimeout(expiryTimer); app.server.closeAllConnections(); app.server.close(); exit(); }
}

void main().catch(() => { console.error("Beam local spike failed; check fixture build and paths."); process.exitCode = 1; });
