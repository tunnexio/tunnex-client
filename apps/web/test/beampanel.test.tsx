import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { BeamPanel, beamStatus } from "../src/client/BeamPanel";
import type { BeamShare, BeamView } from "../src/lib/beamtypes";
const id = "12345678-1234-4234-8234-123456789abc";
const alice = "22345678-1234-4234-8234-123456789abc";
const share: BeamShare = {
  id,
  publisher_id: id,
  created_at: new Date().toISOString(),
  name: "Checkout",
  hostname: "sample.beam.example",
  url: "https://sample.beam.example",
  state: "active",
  target: { address: "127.0.0.1", port: 3000, protocol: "http" },
  version: 1,
  expires_at: new Date(Date.now() + 7200000).toISOString(),
  // The server always grants the publisher; Alice is the chosen reviewer.
  grants: [
    { subject_kind: "user", subject_id: id },
    { subject_kind: "user", subject_id: alice },
  ],
  local_status: "live",
};
const view: BeamView = {
  policy: {
    enabled: true,
    can_publish: true,
    domain_ready: true,
    max_duration_seconds: 86400,
    default_duration_seconds: 7200,
    max_shares: 5,
    audience: [{ subject_kind: "user", subject_id: alice, name: "Alice", email: "alice@example.com" }],
  },
  shares: [share],
  server_time: new Date().toISOString(),
};
function install(over: Record<string, unknown> = {}) {
  const beam = {
    view: vi.fn().mockResolvedValue(view),
    checkLocal: vi.fn().mockResolvedValue({ ready: true }),
    create: vi.fn().mockResolvedValue(share),
    action: vi.fn().mockResolvedValue(share),
    previewGrants: vi.fn().mockResolvedValue({
      share_version: 1,
      removed_grant_count: 0,
      affected_reviewer_count: 0,
      affected_reviewer_session_count: 0,
      requires_confirmation: false,
    }),
    retry: vi.fn().mockResolvedValue(undefined),
    idempotencyKey: vi.fn().mockResolvedValue(id),
    copyLink: vi.fn().mockResolvedValue(undefined),
    openLink: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...over,
  };
  window.tunnex = { beam } as unknown as NonNullable<Window["tunnex"]>;
  return beam;
}
afterEach(() => {
  cleanup();
  delete window.tunnex;
});
describe("Beam desktop review workflow", () => {
  it("lists paused, offline and connecting shares with their actions and hides ended ones", async () => {
    const visible: BeamShare[] = [
      {...share, id:"paused", name:"Paused app", state:"paused", local_status:"offline"},
      {...share, id:"offline", name:"Offline app", local_status:"offline"},
      {...share, id:"connecting", name:"Connecting app", local_status:"starting"},
      {...share, id:"down", name:"Stopped origin", local_status:"app_unavailable"},
    ];
    const hidden: BeamShare[] = [
      {...share, id:"expired", name:"Expired app", expires_at:"2000-01-01"},
      {...share, id:"stopped", name:"Stopped app", state:"stopped"},
      {...share, id:"invalid", name:"Invalid expiry", expires_at:"invalid"},
    ];
    const beam = install({view:vi.fn().mockResolvedValue({...view, shares:[share,...visible,...hidden]})});
    render(<BeamPanel />); await screen.findByText("Checkout");
    for (const item of hidden) expect(screen.queryByText(item.name)).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(5);
    const card = (name: string) => within(screen.getByRole("heading", {name}).closest("article")!);
    expect(card("Paused app").getByText("Paused")).toBeTruthy();
    expect(card("Paused app").getByText("Reviewers can't open it until you resume it.")).toBeTruthy();
    expect(card("Offline app").getByText(/Choose Reconnect/)).toBeTruthy();
    expect(card("Connecting app").getByText("Going live")).toBeTruthy();
    expect(card("Stopped origin").getByText("App not responding")).toBeTruthy();
    expect((card("Connecting app").getByRole("button", {name:"Open"}) as HTMLButtonElement).disabled).toBe(true);
    expect((card("Checkout").getByRole("button", {name:"Open"}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(card("Offline app").getByRole("button", {name:"Reconnect"}));
    await waitFor(() => expect(beam.retry).toHaveBeenCalledWith("offline"));
    fireEvent.click(card("Paused app").getByRole("button", {name:"Resume"}));
    await waitFor(() => expect(beam.action).toHaveBeenCalledWith({id:"paused", version:1, action:"resume"}));
    await screen.findByText("Share resumed. It shows Live again in a few seconds.");
  });
  it("removes a live card at expiry without waiting for the next inventory refresh", async () => {
    vi.useFakeTimers();
    try {
      install({view:vi.fn().mockResolvedValue({...view,server_time:new Date().toISOString(),shares:[{...share,expires_at:new Date(Date.now()+2000).toISOString()}]})});
      await act(async()=>{render(<BeamPanel />);});
      expect(screen.getByText("Checkout")).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
      expect(screen.queryByText("Checkout")).toBeNull();
      expect(screen.getByText("No active shares right now.")).toBeTruthy();
    } finally { cleanup();vi.useRealTimers(); }
  });
  it("finds only common loopback ports on demand and publishes the checked API route", async () => {
    const beam=install({view:vi.fn().mockResolvedValue({...view,policy:{...view.policy,capabilities:["path_routes_v1"]}})});
    render(<BeamPanel />);await screen.findByText("Checkout");
    expect(beam.checkLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"New share"}));
    fireEvent.click(screen.getByRole("button",{name:"Find local apps"}));
    await screen.findByRole("button",{name:"Port 5173"});
    expect(screen.getByText("Apps answered on 6 ports. Choose one.")).toBeTruthy();
    expect(beam.checkLocal).toHaveBeenCalledTimes(6);
    for (const [target] of beam.checkLocal.mock.calls) expect(target).toMatchObject({address:"127.0.0.1",protocol:"http"});
    fireEvent.click(screen.getByRole("button",{name:"Port 5173"}));
    fireEvent.change(screen.getByLabelText("App name"),{target:{value:"Frontend API"}});
    fireEvent.change(screen.getByLabelText("API local port"),{target:{value:"8080"}});
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.click(screen.getByRole("button",{name:"Check app"}));
    await screen.findByText("Your app responded on 127.0.0.1:5173.");
    expect(beam.checkLocal).toHaveBeenLastCalledWith({address:"127.0.0.1",protocol:"http",port:5173,routes:[{path_prefix:"/api",target:{address:"127.0.0.1",protocol:"http",port:8080}}]});
    fireEvent.click(screen.getByRole("button",{name:"Create share"}));
    await waitFor(()=>expect(beam.create).toHaveBeenCalled());
    expect(beam.create.mock.calls[0][0].target.routes[0].target.port).toBe(8080);
  });

  it("previews removal and writes only after explicit confirmation, using the preview version", async () => {
    const beam = install({
      previewGrants: vi.fn().mockResolvedValue({
        share_version: 2,
        removed_grant_count: 1,
        affected_reviewer_count: 2,
        affected_reviewer_session_count: 3,
        requires_confirmation: true,
      }),
    });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByRole("dialog", {
      name: "Confirm reviewer access removal",
    });
    // The publisher's automatic grant has no checkbox and is always sent back.
    expect(beam.previewGrants).toHaveBeenCalledWith({
      id,
      version: 1,
      grants: [{ subject_kind: "user", subject_id: id }],
    });
    expect(beam.action).not.toHaveBeenCalled();
    expect(screen.getByText("This removes 1 reviewer selection from Checkout.")).toBeTruthy();
    expect(screen.getByText(/2 people will lose access, and 3 open sessions will end/)).toBeTruthy();
    expect(screen.queryByText(/audience rule|\(s\)/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal" }));
    expect(beam.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() =>
      expect(beam.action).toHaveBeenCalledWith({
        id,
        version: 2,
        action: "grants",
        grants: [{ subject_kind: "user", subject_id: id }],
        confirm_reviewer_removal: true,
      }),
    );
  });
  it("shows live serving and invokes canonical link by resource ID", async () => {
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Reviewers: Alice")).toBeTruthy();
    expect(screen.queryByText(/audience rule/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(beam.copyLink).toHaveBeenCalledWith(id));
    await screen.findByText("Link copied. Reviewers still need access and sign-in.");
    expect(screen.queryByText("tnx_secret")).toBeNull();
  });
  it("requires an explicit reviewer and fresh local check; changing target invalidates ready", async () => {
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    const createButton = () => screen.getByRole("button", { name: "Create share" }) as HTMLButtonElement;
    const reason = () => document.getElementById(createButton().getAttribute("aria-describedby") ?? "")?.textContent;
    expect(reason()).toBe("Name the app reviewers will see.");
    fireEvent.change(screen.getByLabelText("App name"), {
      target: { value: "Preview" },
    });
    expect(reason()).toBe("Check the app first.");
    fireEvent.click(screen.getByLabelText(/Alice/));
    expect(
      (
        screen.getByRole("button", {
          name: "Create share",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check app" }));
    await screen.findByText("Your app responded on 127.0.0.1:3000.");
    expect(createButton().disabled).toBe(false);
    expect(createButton().getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Alice/));
    expect(createButton().disabled).toBe(true);
    expect(reason()).toBe("Choose at least one reviewer.");
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.change(screen.getByLabelText("Local port"), {
      target: { value: "4000" },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Create share",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(beam.create).not.toHaveBeenCalled();
  });
  it("server failure preserves inventory and displays a retryable failure", async () => {
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    beam.view.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("No active shares right now.")).toBeNull();
  });
  it("cannot show expired or paused resource as Live from stale connectivity", () => {
    expect(
      beamStatus({ ...share, state: "paused", local_status: "live" }),
    ).toBe("Paused");
    expect(
      beamStatus({ ...share, expires_at: "2000-01-01", local_status: "live" }),
    ).toBe("Expired");
  });
  it("policy denial blocks creation and does not infer reviewer grants", async () => {
    install({
      view: vi.fn().mockResolvedValue({
        ...view,
        policy: { ...view.policy, can_publish: false },
      }),
    });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    const newShare = screen.getByRole("button", { name: "New share" }) as HTMLButtonElement;
    expect(newShare.disabled).toBe(true);
    expect(document.getElementById(newShare.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Your account can open apps shared with you but can't share its own. Ask an administrator for publishing access.",
    );
  });
});

describe("Beam inventory and compatibility controls", () => {
  it("uses server pages/search and exposes concrete app compatibility guidance", async () => {
    const beam = install({
      view: vi.fn().mockResolvedValue({
        ...view,
        page: { offset: 0, limit: 20, has_next: true },
        quota: { active_shares: 3, max_shares: 5 },
      }),
    });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Next shares" }));
    await waitFor(() =>
      expect(beam.view).toHaveBeenCalledWith({ offset: 20, query: "" }),
    );
    fireEvent.change(screen.getByLabelText("Search shares"), {
      target: { value: "cart" },
    });
    await waitFor(() =>
      expect(beam.view).toHaveBeenCalledWith({ offset: 0, query: "cart" }),
    );
    expect(screen.getByText("3 of 5 active shares")).toBeTruthy();
    expect(screen.getByText("App compatibility and sharing help")).toBeTruthy();
    expect(screen.getByText(/public WebSocket URL/)).toBeTruthy();
    expect(screen.queryByText(/\bv1\b/)).toBeNull();
    expect(screen.getByText(/Quit ends sharing and stops your shares/)).toBeTruthy();
  });
});


describe("LS-CLIENT-1 Local Sharing wording and reasons", () => {
  it("drops the App Access eyebrow and keeps the Local Sharing promise", async () => {
    install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    expect(screen.getByRole("heading", { level: 1, name: "Local Sharing" })).toBeTruthy();
    expect(screen.queryByText(/PRIVATE APP ACCESS/i)).toBeNull();
    expect(screen.getByText("Your local apps. A private link away.")).toBeTruthy();
    expect(screen.getByText("Works independently of your VPN")).toBeTruthy();
  });
  it("pluralizes lifetimes and shows reviewers as Name (email) without the publisher", async () => {
    install({ view: vi.fn().mockResolvedValue({ ...view, policy: { ...view.policy, max_duration_seconds: 5400, audience: [...view.policy.audience, { subject_kind: "group", subject_id: id.replace("1234-4234", "9999-4999"), name: "Developers" }] } }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    const options = within(screen.getByLabelText("Link lifetime")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["15 minutes", "30 minutes", "1 hour", "1 hour 30 minutes"]);
    expect(screen.queryByText(/1 hours/)).toBeNull();
    const reviewers = within(screen.getByRole("group", { name: "Who can review?" }));
    expect(reviewers.getByLabelText("Alice (alice@example.com)")).toBeTruthy();
    expect(reviewers.getByLabelText("Developers group")).toBeTruthy();
    expect(reviewers.queryByText(/^(user|group)$/)).toBeNull();
  });
  it("blocks New share at the slot limit and says why", async () => {
    install({ view: vi.fn().mockResolvedValue({ ...view, quota: { active_shares: 5, max_shares: 5 } }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    const newShare = screen.getByRole("button", { name: "New share" }) as HTMLButtonElement;
    expect(newShare.disabled).toBe(true);
    expect(document.getElementById(newShare.getAttribute("aria-describedby")!)?.textContent).toBe(
      "You have 5 active shares, your organization's limit. Stop a share to create another.",
    );
  });
  it("says why Extend is unavailable at the organization's maximum lifetime", async () => {
    const created = new Date().toISOString();
    install({ view: vi.fn().mockResolvedValue({ ...view, policy: { ...view.policy, max_duration_seconds: 3600 }, shares: [{ ...share, created_at: created, expires_at: new Date(Date.parse(created) + 3600_000).toISOString() }] }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    const extend = screen.getByRole("button", { name: "Extend" }) as HTMLButtonElement;
    expect(extend.disabled).toBe(true);
    expect(document.getElementById(extend.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Already at your organization's maximum lifetime of 1 hour.",
    );
  });
  it("offers extensions in plain durations", async () => {
    const created = new Date().toISOString();
    install({ view: vi.fn().mockResolvedValue({ ...view, policy: { ...view.policy, max_duration_seconds: 14400 }, shares: [{ ...share, created_at: created, expires_at: new Date(Date.parse(created) + 3600_000).toISOString() }] }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Extend" }));
    const options = within(screen.getByLabelText("Add share time")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("1 minute");
    expect(options).toContain("1 hour");
    expect(options).toContain("2 hours");
    expect(options.some((label) => /1 minutes|1 hours|120 minutes/.test(label ?? ""))).toBe(false);
  });
  it("confirms Stop in the app before stopping", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop this share" });
    expect(within(dialog).getByText(/Stop Checkout permanently\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep sharing" }));
    expect(beam.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(beam.action).toHaveBeenCalledWith({ id, version: 1, action: "stop" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it("reports creation plainly, without connector jargon", async () => {
    const beam = install({ create: vi.fn().mockResolvedValue({ ...share, local_status: "starting" }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    fireEvent.change(screen.getByLabelText("App name"), { target: { value: "Preview" } });
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.click(screen.getByRole("button", { name: "Check app" }));
    await screen.findByText("Your app responded on 127.0.0.1:3000.");
    fireEvent.click(screen.getByRole("button", { name: "Create share" }));
    await screen.findByText("Share created. It shows Live in a few seconds; reviewers can open it after signing in.");
    expect(beam.create.mock.calls[0][0].grants).toEqual([{ subject_kind: "user", subject_id: alice }]);
    expect(screen.queryByText(/connector/i)).toBeNull();
  });
  it("tells people what a failed app check means", async () => {
    install({ checkLocal: vi.fn().mockResolvedValue({ ready: false }) });
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    fireEvent.click(screen.getByRole("button", { name: "Check app" }));
    await screen.findByText("Nothing answered on 127.0.0.1:3000. Start your app or check the port and protocol.");
  });
  it("shows the policy message when the server refuses the publisher view", async () => {
    install({ view: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'beam:view': Error: beam_quota_reached")) });
    render(<BeamPanel />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You've reached your organization's limit of active shares. Stop a share to create another.",
    );
  });
});
