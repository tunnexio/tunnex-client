import { describe, expect, it, vi } from "vitest";
import { connectionPathLabel, mapStatus } from "../src/client/ClientApp";

describe("native connection status", () => {
  it("shows only measured safe path labels and never guesses for old helpers", () => {
    expect(connectionPathLabel("relay")).toBe("Relay");
    expect(connectionPathLabel("direct")).toBe("Direct");
    expect(connectionPathLabel("negotiating")).toBe("Negotiating");
    for (const unknown of [undefined, null, "unknown", "secret-endpoint", {}]) {
      expect(connectionPathLabel(unknown)).toBe("Path unavailable");
    }
  });
  it("requires a fresh handshake, not merely an interface", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000000);
    try {
      expect(mapStatus({ state: "up" })).toBe("connecting");
      expect(mapStatus({ state: "up", last_handshake_sec: 0 })).toBe("connecting");
      expect(mapStatus({ state: "up", last_handshake_sec: 800 })).toBe("connecting");
      expect(mapStatus({ state: "up", last_handshake_sec: 990 })).toBe("connected");
      expect(mapStatus({ state: "failed", last_handshake_sec: 990 })).toBe("failed");
    } finally { clock.mockRestore(); }
  });
});
