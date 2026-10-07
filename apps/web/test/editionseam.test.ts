import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readGeneratedFile } from "./support/source";
import {
  ENTERPRISE_PATHS,
  isEnterprisePath,
  isEnterprise,
  gate,
} from "../src/lib/edition";

// ⛔ THE SWEEP, MADE STRUCTURAL.
//
// The edition-vs-failure conflation was fixed once, at one call site, and was STILL LIVE two cards over. A fix
// at a call site does not reach the call sites beside it — only an enumeration finds the rest, and only a
// census keeps the enumeration true.

// The standalone desktop renderer consumes a pinned core API contract snapshot.
// Refresh from committed core source with test/support/refresh-core-contracts.mjs;
// this repository has no generated control-plane OpenAPI tree.
const contract = JSON.parse(
  readGeneratedFile(
    fileURLToPath(
      new URL("./fixtures/core-operation-contract.json", import.meta.url),
    ),
    fileURLToPath(new URL("./fixtures/", import.meta.url)),
  ),
) as {
  provenance: { revision: string; sha256: string };
  operations: Array<{
    path: string;
    summary: string;
    edition_required: boolean;
  }>;
};
function specEnterprisePaths(): Set<string> {
  return new Set(
    contract.operations
      .filter(
        (operation) =>
          operation.edition_required ||
          /\benterprise\b/i.test(operation.summary),
      )
      .map((operation) => operation.path),
  );
}

describe("ENTERPRISE_PATHS is held to the SPEC, not to memory", () => {
  const fromSpec = specEnterprisePaths();

  it("the spec parse is non-trivial — a census over zero paths cannot fail", () => {
    expect(fromSpec.size).toBeGreaterThanOrEqual(20);
  });

  it("EVERY enterprise path in the spec is registered here", () => {
    // ⛔ THIS IS THE STRUCTURAL HALF. Add an enterprise endpoint to the spec and this goes red until it is
    // registered — so a new enterprise card cannot reach a screen without passing through the seam.
    const missing = [...fromSpec].filter((p) => !isEnterprisePath(p));
    expect(
      missing,
      `enterprise in the spec but NOT registered:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("nothing is registered that the spec does not gate — the set must not drift wider either", () => {
    // A set that over-claims is its own defect: it would render an OPEN capability as absent for open-edition
    // orgs, which is the same lie pointing the other way.
    const extra = ENTERPRISE_PATHS.filter((p) => !fromSpec.has(p));
    expect(
      extra,
      `registered but NOT enterprise in the spec:\n  ${extra.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("gate() — the render decision, taken at the seam", () => {
  const ENT = "/api/v1/organizations/{orgId}/policies";
  const OPEN = "/api/v1/organizations/{orgId}/nodes";

  it("Community agent inventory, approval and health capabilities remain reachable", () => {
    for (const path of [
      "agents",
      "device-approval",
      "devices/pending",
      "devices/{deviceId}/approve",
      "devices/{deviceId}/reject",
      "devices/{deviceId}/health",
      "health-checks",
      "health-checks/{checkKind}",
    ]) {
      expect(
        gate("open", `/api/v1/organizations/{orgId}/${path}`, {
          state: "ok",
          data: true,
        }),
      ).toEqual({ state: "ok", data: true });
    }
  });

  it("open edition + enterprise endpoint = ABSENT, never failed", () => {
    // The exact defect: the open edition rendered "could not load" IN RED for a feature it was never sold.
    expect(gate("open", ENT, null)).toEqual({ state: "absent" });
    expect(gate("open", ENT, { state: "failed" })).toEqual({ state: "absent" });
  });

  it("UNKNOWN edition is treated as not-enterprise — no flash before /meta answers", () => {
    expect(gate("unknown", ENT, null)).toEqual({ state: "absent" });
  });

  it("enterprise edition passes the real result through", () => {
    expect(gate("enterprise", ENT, { state: "ok", data: 3 })).toEqual({
      state: "ok",
      data: 3,
    });
    expect(gate("enterprise", ENT, { state: "failed" })).toEqual({
      state: "failed",
    });
  });

  it("a NON-enterprise endpoint is never absented, whatever the edition", () => {
    expect(gate("open", OPEN, { state: "failed" })).toEqual({
      state: "failed",
    });
    expect(gate("open", OPEN, { state: "ok", data: 1 })).toEqual({
      state: "ok",
      data: 1,
    });
  });

  it("a still-loading gated call reads as loading, not absent, on enterprise", () => {
    expect(gate("enterprise", ENT, null)).toEqual({ state: "loading" });
  });

  it("isEnterprise treats unknown as NOT enterprise", () => {
    expect(isEnterprise("unknown")).toBe(false);
    expect(isEnterprise("open")).toBe(false);
    expect(isEnterprise("enterprise")).toBe(true);
  });
});
