import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BeamPanel, beamStatus } from "../src/client/BeamPanel";
import type { BeamShare, BeamView } from "../src/lib/beamtypes";
const id = "12345678-1234-4234-8234-123456789abc";
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
  grants: [{ subject_kind: "user", subject_id: id }],
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
    audience: [{ subject_kind: "user", subject_id: id, name: "Alice" }],
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
  it("removes all non-live cards, including elapsed expiry with a stale active projection", async () => {
    const hidden: BeamShare[] = [
      {...share, id:"expired", name:"Expired app", expires_at:"2000-01-01"},
      {...share, id:"stopped", name:"Stopped app", state:"stopped"},
      {...share, id:"paused", name:"Paused app", state:"paused"},
      {...share, id:"offline", name:"Offline app", local_status:"offline"},
      {...share, id:"connecting", name:"Connecting app", local_status:"starting"},
      {...share, id:"invalid", name:"Invalid expiry", expires_at:"invalid"},
    ];
    install({view:vi.fn().mockResolvedValue({...view, shares:[share,...hidden]})});
    render(<BeamPanel />); await screen.findByText("Checkout");
    for (const item of hidden) expect(screen.queryByText(item.name)).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
  it("removes a live card at expiry without waiting for the next inventory refresh", async () => {
    vi.useFakeTimers();
    try {
      install({view:vi.fn().mockResolvedValue({...view,server_time:new Date().toISOString(),shares:[{...share,expires_at:new Date(Date.now()+2000).toISOString()}]})});
      await act(async()=>{render(<BeamPanel />);});
      expect(screen.getByText("Checkout")).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
      expect(screen.queryByText("Checkout")).toBeNull();
      expect(screen.getByText("No live shares right now.")).toBeTruthy();
    } finally { cleanup();vi.useRealTimers(); }
  });
  it("finds only common loopback ports on demand and publishes the checked API route", async () => {
    const beam=install({view:vi.fn().mockResolvedValue({...view,policy:{...view.policy,capabilities:["path_routes_v1"]}})});
    render(<BeamPanel />);await screen.findByText("Checkout");
    expect(beam.checkLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"New share"}));
    fireEvent.click(screen.getByRole("button",{name:"Find local apps"}));
    await screen.findByRole("button",{name:"Port 5173"});
    expect(beam.checkLocal).toHaveBeenCalledTimes(6);
    for (const [target] of beam.checkLocal.mock.calls) expect(target).toMatchObject({address:"127.0.0.1",protocol:"http"});
    fireEvent.click(screen.getByRole("button",{name:"Port 5173"}));
    fireEvent.change(screen.getByLabelText("App name"),{target:{value:"Frontend API"}});
    fireEvent.change(screen.getByLabelText("API local port"),{target:{value:"8080"}});
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.click(screen.getByRole("button",{name:"Check app"}));
    await screen.findByText("App responded");
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
    expect(beam.previewGrants).toHaveBeenCalledWith({
      id,
      version: 1,
      grants: [],
    });
    expect(beam.action).not.toHaveBeenCalled();
    expect(screen.getByText(/2 reviewer\(s\) and 3 signed-in/)).toBeTruthy();
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
        grants: [],
        confirm_reviewer_removal: true,
      }),
    );
  });
  it("shows live serving and invokes canonical link by resource ID", async () => {
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    expect(screen.getByText("Live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(beam.copyLink).toHaveBeenCalledWith(id));
    expect(screen.queryByText("tnx_secret")).toBeNull();
  });
  it("requires an explicit reviewer and fresh local check; changing target invalidates ready", async () => {
    const beam = install();
    render(<BeamPanel />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    fireEvent.change(screen.getByLabelText("App name"), {
      target: { value: "Preview" },
    });
    fireEvent.click(screen.getByLabelText(/Alice/));
    expect(
      (
        screen.getByRole("button", {
          name: "Create share",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check app" }));
    await screen.findByText("App responded");
    expect(
      (
        screen.getByRole("button", {
          name: "Create share",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
    expect(screen.queryByText("No live shares right now.")).toBeNull();
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
    expect(
      (screen.getByRole("button", { name: "New share" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
    expect(screen.getByText("3 / 5 active shares")).toBeTruthy();
    expect(screen.getByText("App compatibility and sharing help")).toBeTruthy();
    expect(screen.getByText(/public WebSocket URL/)).toBeTruthy();
  });
});
