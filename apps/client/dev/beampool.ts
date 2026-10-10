import { runBeamChannelPool } from "../src/main/beamchannelpool";
import type { BeamChannelOptions } from "../src/main/beamconnector";
// Fixtures exercise the same bounded channel supervision as the product runtime.
export function runBeamFixturePool(
  options: BeamChannelOptions,
  signal: AbortSignal,
): Promise<void> {
  return runBeamChannelPool(options, signal);
}
