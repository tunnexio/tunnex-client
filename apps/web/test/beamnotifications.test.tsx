import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BeamReviewNotifications } from "../src/client/BeamReviewNotifications";
import type { BeamSharedShare } from "../src/lib/beamtypes";
import type { ClientNotice } from "../src/lib/desktop";
const app: BeamSharedShare = {id:"review-app",name:"Checkout redesign",publisher_name:"Designer",hostname:"p-preview.example.net",url:"https://p-preview.example.net/",state:"active",connectivity:"online",can_open:true,expires_at:"2099-01-01T00:00:00Z"};
function install(shares: BeamSharedShare[] = [app]) {
  const result = {shares,server_time:new Date().toISOString(),page:{offset:0,limit:20,has_next:false}};
  const beam = {notifications:vi.fn().mockResolvedValue(result),openSharedLink:vi.fn().mockImplementation(async()=>{beam.notifications.mockResolvedValue({...result,shares:[]});}),onChanged:vi.fn().mockReturnValue(()=>{})};
  window.tunnex = {beam} as unknown as NonNullable<Window["tunnex"]>; return beam;
}
afterEach(()=>{cleanup();delete window.tunnex;vi.useRealTimers();});
describe("Home review notifications",()=>{
  it("clears after opening once and stays absent after Home remount",async()=>{
    const beam = install(); const first = render(<BeamReviewNotifications />);
    fireEvent.click(await screen.findByRole("button",{name:"Notifications, 1 unread"}));
    await screen.findByRole("heading",{name:"Checkout redesign"});
    expect(screen.getByText("Shared by Designer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Open Checkout redesign for review"}));
    await waitFor(()=>expect(screen.queryByRole("region",{name:"Notifications"})).toBeNull());
    expect(beam.openSharedLink).toHaveBeenCalledWith(app.id);
    first.unmount(); render(<BeamReviewNotifications />);
    await act(async()=>{});
    expect(screen.queryByRole("region",{name:"Notifications"})).toBeNull();
  });
  it("keeps the notification when the browser fails to open",async()=>{
    const beam = install(); beam.openSharedLink.mockRejectedValue(new Error("browser_failed")); render(<BeamReviewNotifications />);
    fireEvent.click(await screen.findByRole("button",{name:"Notifications, 1 unread"}));
    fireEvent.click(await screen.findByRole("button",{name:"Open Checkout redesign for review"}));
    await screen.findByRole("alert"); expect(screen.getByRole("heading",{name:app.name})).toBeTruthy();
  });
  it("hides unavailable shares and removes expiry before the next poll",async()=>{
    vi.useFakeTimers();install([{...app,expires_at:new Date(Date.now()+2000).toISOString()},{...app,id:"offline",name:"Offline",connectivity:"offline"},{...app,id:"revoked",name:"Revoked",can_open:false},{...app,id:"paused",name:"Paused",state:"paused"}]);
    render(<BeamReviewNotifications />); await act(async()=>{});
    fireEvent.click(screen.getByRole("button",{name:"Notifications, 1 unread"}));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(screen.getByRole("button",{name:"Notifications, 0 unread"})).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
  it("picks up new shares while Home is open and removes a failed session read",async()=>{
    vi.useFakeTimers();const beam = install([]);render(<BeamReviewNotifications />);await act(async()=>{});
    beam.notifications.mockResolvedValue({shares:[app],server_time:new Date().toISOString(),page:{offset:0,limit:20,has_next:false}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    fireEvent.click(screen.getByRole("button",{name:"Notifications, 1 unread"}));
    expect(screen.getByRole("heading",{name:app.name})).toBeTruthy();
    beam.notifications.mockRejectedValue(new Error("beam_session_changed"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(screen.getByRole("button",{name:"Notifications, 0 unread"})).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
  it("uses only a compact bell until clicked and closing the list does not consume the notification",async()=>{
    const beam = install();render(<BeamReviewNotifications />);
    const bell = await screen.findByRole("button",{name:"Notifications, 1 unread"});
    expect(screen.queryByRole("heading",{name:"Shared for review"})).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.click(bell);expect(screen.getByRole("heading",{name:app.name})).toBeTruthy();
    fireEvent.keyDown(window,{key:"Escape"});
    expect(screen.queryByRole("article")).toBeNull();
    expect(beam.openSharedLink).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"Notifications, 1 unread"})).toBeTruthy();
  });
});

function installNotices(entries:ClientNotice[], includeApp=false) {
  const beam=install(includeApp?[app]:[]);
  let unread=entries;
  const notices={list:vi.fn().mockImplementation(async()=>unread),markRead:vi.fn().mockImplementation(async(id:string)=>{unread=unread.filter(item=>item.id!==id);}),onChanged:vi.fn().mockReturnValue(()=>{})};
  const diag={openReleaseDownload:vi.fn().mockResolvedValue(undefined)};
  window.tunnex={beam,notices,diag} as unknown as NonNullable<Window["tunnex"]>;
  return {beam,notices,diag};
}
const notice=(kind:ClientNotice["kind"],title:string):ClientNotice=>({id:kind,kind,title,body:"An authoritative event from Tunnex.",created_at:new Date().toISOString()});
describe("Unified desktop bell",()=>{
  it("combines app review, access/device revocation and release notices without a full Home frame",async()=>{
    const bridge=installNotices([notice("access_revoked","App access revoked"),notice("device_revoked","Device revoked"),notice("update_available","Update available: v0.1.8")],true);
    render(<BeamReviewNotifications />);
    const bell=await screen.findByRole("button",{name:"Notifications, 4 unread"});
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.click(bell);
    expect(screen.getAllByRole("article")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button",{name:"Mark Device revoked as read"}));
    await screen.findByRole("button",{name:"Notifications, 3 unread"});
    expect(bridge.notices.markRead).toHaveBeenCalledWith("device_revoked");
    expect(bridge.diag.openReleaseDownload).not.toHaveBeenCalled();
  });
  it("shows a global update while signed out and opens only the native official download action",async()=>{
    const bridge=installNotices([notice("update_available","Update available: v0.1.8")]);
    render(<BeamReviewNotifications includeReviews={false} />);
    fireEvent.click(await screen.findByRole("button",{name:"Notifications, 1 unread"}));
    fireEvent.click(screen.getByRole("button",{name:"Download update"}));
    await screen.findByRole("button",{name:"Notifications, 0 unread"});
    expect(bridge.diag.openReleaseDownload).toHaveBeenCalledOnce();
    expect(bridge.beam.notifications).not.toHaveBeenCalled();
  });
  it("keeps update unread if download-page launch fails",async()=>{
    const bridge=installNotices([notice("update_available","Update available: v0.1.8")]);bridge.diag.openReleaseDownload.mockRejectedValue(new Error("launch_failed"));
    render(<BeamReviewNotifications />);
    fireEvent.click(await screen.findByRole("button",{name:"Notifications, 1 unread"}));fireEvent.click(screen.getByRole("button",{name:"Download update"}));
    await screen.findByRole("alert");expect(bridge.notices.markRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"Notifications, 1 unread"})).toBeTruthy();
  });
  it("retains security notifications independently of failed Beam inventory",async()=>{
    const bridge=installNotices([notice("device_revoked","Device revoked")]);bridge.beam.notifications.mockRejectedValue(new Error("beam_denied"));
    render(<BeamReviewNotifications />);fireEvent.click(await screen.findByRole("button",{name:"Notifications, 1 unread"}));
    expect(screen.getByRole("heading",{name:"Device revoked"})).toBeTruthy();
  });
});
