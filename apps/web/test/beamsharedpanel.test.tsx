import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BeamPanel } from "../src/client/BeamPanel";
import type { BeamSharedShare } from "../src/lib/beamtypes";
const app: BeamSharedShare = {id:"review-app",name:"Checkout redesign",publisher_name:"Designer",hostname:"p-preview.example.net",url:"https://p-preview.example.net/",state:"active",connectivity:"online",can_open:true,expires_at:"2099-01-01T00:00:00Z"};
function install(shares: BeamSharedShare[]=[app]) {
  const beam={view:vi.fn().mockResolvedValue({policy:{enabled:false,can_publish:false,domain_ready:true,max_duration_seconds:3600,audience:[]},shares:[],server_time:new Date().toISOString()}),shared:vi.fn().mockResolvedValue({shares,server_time:new Date().toISOString(),page:{offset:0,limit:20,has_next:false}}),openSharedLink:vi.fn().mockResolvedValue(undefined),onChanged:vi.fn().mockReturnValue(()=>{})};
  window.tunnex={beam} as unknown as NonNullable<Window["tunnex"]>; return beam;
}
function show() {render(<BeamPanel />);fireEvent.click(screen.getByRole("button",{name:"Shared with me"}));}
afterEach(()=>{cleanup();delete window.tunnex;vi.useRealTimers();});
describe("Desktop shared apps",()=>{
  it("lets a reviewer without publishing permission find and open a teammate app by resource ID",async()=>{
    const beam=install();show();await screen.findByText("Checkout redesign");
    expect(screen.getByText("Shared by Designer")).toBeTruthy();
    expect(screen.queryByRole("button",{name:"New share"})).toBeNull();
    expect(screen.queryByRole("button",{name:"Stop"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Open Checkout redesign in browser"}));
    await waitFor(()=>expect(beam.openSharedLink).toHaveBeenCalledWith(app.id));
    expect(screen.getByText(/Sign in there if needed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search shared apps"),{target:{value:"cart"}});
    await waitFor(()=>expect(beam.shared).toHaveBeenLastCalledWith({offset:0,query:"cart"}));
  });
  it("omits ended, offline and revoked-access cards and removes elapsed expiry between polls",async()=>{
    vi.useFakeTimers();
    install([{...app,expires_at:new Date(Date.now()+2000).toISOString()},{...app,id:"denied",name:"Denied",can_open:false},{...app,id:"paused",name:"Paused",state:"paused"},{...app,id:"offline",name:"Offline",connectivity:"offline"}]);
    render(<BeamPanel />);
    await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Shared with me"}));});expect(screen.getAllByRole("article")).toHaveLength(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("No live apps are currently shared with you.")).toBeTruthy();
  });
  it("shows revoked access when Open fails and refreshes the grant-scoped list",async()=>{
    const beam=install();beam.openSharedLink.mockRejectedValue(new Error("beam_shared_access_unavailable"));show();await screen.findByText(app.name);
    beam.shared.mockResolvedValue({shares:[],server_time:new Date().toISOString(),page:{offset:0,limit:20,has_next:false}});
    fireEvent.click(screen.getByRole("button",{name:"Open Checkout redesign in browser"}));
    await screen.findByText("No live apps are currently shared with you.");
    expect(beam.shared.mock.calls.length).toBeGreaterThan(1);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This app is no longer available to your account. Refresh shared apps.");
  });
});
