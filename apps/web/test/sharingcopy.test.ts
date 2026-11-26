import { describe, expect, it } from "vitest";
import {
  audienceLabel,
  createBlockReason,
  extendBlockReason,
  formatDuration,
  formatRemaining,
  groupLabel,
  personLabel,
  publishBlockReason,
  reviewerSummary,
} from "../src/client/sharingcopy";
import type { BeamAudience, BeamPolicy } from "../src/lib/beamtypes";

const me = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const devs = "00000000-0000-4000-8000-000000000004";
const audience: BeamAudience[] = [
  { subject_kind: "user", subject_id: alice, name: "Alice", email: "alice@example.com" },
  { subject_kind: "user", subject_id: bob, name: "Bob" },
  { subject_kind: "group", subject_id: devs, name: "Developers" },
];
const policy: BeamPolicy = {
  enabled: true,
  can_publish: true,
  domain_ready: true,
  max_duration_seconds: 3600,
  default_duration_seconds: 3600,
  max_shares: 5,
  audience,
};

describe("Local Sharing wording (LS-CLIENT-1)", () => {
  it("pluralizes every duration in plain words", () => {
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(900)).toBe("15 minutes");
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(7200)).toBe("2 hours");
    expect(formatDuration(5400)).toBe("1 hour 30 minutes");
    expect(formatDuration(3660)).toBe("1 hour 1 minute");
    expect(formatDuration(86400)).toBe("24 hours");
    for (const seconds of [60, 900, 3600, 5400, 7200, 14400, 86400])
      expect(formatDuration(seconds)).not.toMatch(/\b1 (hours|minutes)\b/);
  });
  it("counts down without abbreviations", () => {
    expect(formatRemaining(20_000)).toBe("less than a minute");
    expect(formatRemaining(60_000)).toBe("1 minute");
    expect(formatRemaining(61_000)).toBe("2 minutes");
    expect(formatRemaining(3_900_000)).toBe("1 hour 5 minutes");
    expect(formatRemaining(-5)).toBe("less than a minute");
  });
  it("shows people as Name (email) like the web console", () => {
    expect(personLabel({ name: "Pat", email: "pat@example.com" })).toBe("Pat (pat@example.com)");
    expect(personLabel({ name: "pat@example.com", email: "PAT@example.com" })).toBe("PAT@example.com");
    expect(personLabel({ name: "Pat" })).toBe("Pat");
    expect(personLabel({ email: "pat@example.com" })).toBe("pat@example.com");
    expect(personLabel(undefined, "the publisher")).toBe("the publisher");
  });
  it("names groups once and drops user/group jargon", () => {
    expect(groupLabel("Developers")).toBe("Developers group");
    expect(groupLabel("Design Group")).toBe("Design Group");
    expect(audienceLabel(audience[0])).toBe("Alice (alice@example.com)");
    expect(audienceLabel(audience[2])).toBe("Developers group");
  });
  it("adds a group's member count only when the server sends a number", () => {
    const group = (member_count: unknown) => ({ subject_kind: "group", subject_id: devs, name: "Developers", member_count } as unknown as BeamAudience);
    expect(audienceLabel(group(3))).toBe("Developers group · 3 members");
    expect(audienceLabel(group(1))).toBe("Developers group · 1 member");
    expect(audienceLabel(group(0))).toBe("Developers group · 0 members");
    for (const missing of [undefined, null, "3", Number.NaN, -1, 2.5])
      expect(audienceLabel(group(missing))).toBe("Developers group");
  });
  it("summarizes reviewers without counting the publisher's automatic grant", () => {
    const share = (ids: Array<["user" | "group", string]>) => ({
      publisher_id: me,
      grants: ids.map(([subject_kind, subject_id]) => ({ subject_kind, subject_id })),
    });
    expect(reviewerSummary(share([["user", me], ["user", alice]]), audience)).toBe("Reviewers: Alice");
    expect(reviewerSummary(share([["user", me], ["user", alice], ["group", devs]]), audience)).toBe(
      "Reviewers: Alice, Developers group",
    );
    expect(
      reviewerSummary(share([["user", alice], ["user", bob], ["group", devs], ["user", "unknown-1"], ["user", "unknown-2"]]), audience),
    ).toBe("Reviewers: Alice, Bob, Developers group +2 more");
    expect(reviewerSummary(share([["user", "unknown-1"]]), [])).toBe("1 reviewer");
    expect(reviewerSummary(share([["user", "u1"], ["user", "u2"]]), [])).toBe("2 reviewers");
    expect(reviewerSummary(share([["user", me]]), audience)).toBe(
      "Only you can open it. Choose Access to add reviewers.",
    );
    expect(reviewerSummary(share([["user", me], ["user", alice]]), audience)).not.toMatch(/audience|rule/i);
  });
  it("explains why a share cannot be created, one missing step at a time", () => {
    const ready = { name: "Checkout", port: "3000", apiPort: "", apiPrefix: "/api", check: true, reviewers: 1, available: 3, address: "127.0.0.1" };
    expect(createBlockReason(ready)).toBeNull();
    expect(createBlockReason({ ...ready, name: "  " })).toBe("Name the app reviewers will see.");
    expect(createBlockReason({ ...ready, port: "70000" })).toBe("Enter a port between 1 and 65535.");
    expect(createBlockReason({ ...ready, apiPort: "0" })).toBe("Enter an API port between 1 and 65535, or leave it empty.");
    expect(createBlockReason({ ...ready, apiPort: "8080", apiPrefix: "api" })).toBe(
      "Enter an API path such as /api (letters, numbers, - and _).",
    );
    expect(createBlockReason({ ...ready, check: null })).toBe("Check the app first.");
    expect(createBlockReason({ ...ready, check: false })).toBe(
      "Your app didn't respond on 127.0.0.1:3000. Start it, then check again.",
    );
    expect(createBlockReason({ ...ready, reviewers: 0 })).toBe("Choose at least one reviewer.");
    expect(createBlockReason({ ...ready, reviewers: 0, available: 0 })).toBe(
      "No reviewers are available. Ask an administrator to add reviewers to the Local Sharing policy.",
    );
  });
  it("explains a disabled Extend at the organization's maximum lifetime", () => {
    expect(extendBlockReason(30, 3600)).toBe("Already at your organization's maximum lifetime of 1 hour.");
    expect(extendBlockReason(600, 3600)).toBeNull();
  });
  it("derives publishing blockers from policy and quota, in plain words", () => {
    expect(publishBlockReason(policy)).toBeNull();
    expect(publishBlockReason({ ...policy, enabled: false })).toMatch(/turned off for your organization/);
    expect(publishBlockReason({ ...policy, domain_ready: false })).toMatch(/setup isn't finished/);
    expect(publishBlockReason({ ...policy, can_publish: false })).toMatch(/can open apps shared with you but can't share/);
    expect(publishBlockReason(policy, { active_shares: 5, max_shares: 5 })).toBe(
      "You have 5 active shares, your organization's limit. Stop a share to create another.",
    );
    expect(publishBlockReason(policy, { active_shares: 4, max_shares: 5 })).toBeNull();
    expect(publishBlockReason({ ...policy, can_publish: false, reason: "Custom server reason." })).toBe("Custom server reason.");
    expect(publishBlockReason({ ...policy, reason: "Ignored while publishing is allowed." })).toBeNull();
  });
});
