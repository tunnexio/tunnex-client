import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { desktop, type ClientNotice } from "../lib/desktop";
import type { BeamSharedView } from "../lib/beamtypes";
import { beamError } from "./BeamPanel";

export function BeamReviewNotifications({includeReviews = true}: {includeReviews?:boolean}) {
  const native = desktop();
  const bridge = native?.beam;
  const noticeBridge = native?.notices;
  const [notices, setNotices] = useState<ClientNotice[]>([]);
  const [view, setView] = useState<BeamSharedView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const revision = useRef(0);
  const noticeRevision = useRef(0);
  const locked = useRef(false);
  const refresh = useCallback(async () => {
    if (!includeReviews || !bridge?.notifications) return;
    const current = ++revision.current;
    try {
      const next = await bridge.notifications();
      if (!mounted.current || current !== revision.current) return;
      setView(next);
      setClockOffset(Date.parse(next.server_time) - Date.now());
    } catch {
      // Never retain another account's notification on a failed session read.
      if (mounted.current && current === revision.current) setView(null);
    }
  }, [bridge, includeReviews]);
  const refreshNotices = useCallback(async () => {
    if (!noticeBridge) return;
    const current = ++noticeRevision.current;
    try {const next = await noticeBridge.list(); if (mounted.current && current === noticeRevision.current) setNotices(next);}
    catch {if (mounted.current && current === noticeRevision.current) setNotices([]);}
  }, [noticeBridge]);
  useEffect(() => {
    mounted.current = true;
    if (!includeReviews) setView(null);
    void refresh();
    void refreshNotices();
    const unsubscribe = bridge?.onChanged(() => void refresh());
    const unsubscribeNotices = noticeBridge?.onChanged(() => void refreshNotices());
    const poll = window.setInterval(() => {void refresh();void refreshNotices();}, 15000);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {mounted.current = false; revision.current++; noticeRevision.current++; unsubscribe?.(); unsubscribeNotices?.(); clearInterval(poll); clearInterval(timer);};
  }, [bridge, noticeBridge, refresh, refreshNotices, includeReviews]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {if (!container.current?.contains(event.target as Node)) setExpanded(false);};
    const escape = (event: KeyboardEvent) => {if (event.key === "Escape") {setExpanded(false); trigger.current?.focus();}};
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    return () => {window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape);};
  }, [expanded]);
  async function open(id: string) {
    if (locked.current || !bridge?.openSharedLink) return;
    locked.current = true; setOpening(id); setError("");
    try {
      await bridge.openSharedLink(id);
      if (mounted.current) {setView(previous => previous && {...previous, shares: previous.shares.filter(share => share.id !== id)}); setExpanded(false);}
    } catch (failure) {
      if (mounted.current) setError(beamError(failure));
    } finally {
      locked.current = false;
      if (mounted.current) {setOpening(null); await refresh();}
    }
  }
  async function readNotice(notice: ClientNotice) {
    if (locked.current || !noticeBridge) return;
    locked.current = true; setOpening(notice.id); setError("");
    try {
      if (notice.kind === "update_available") await native?.diag.openReleaseDownload();
      await noticeBridge.markRead(notice.id);
      if (mounted.current) {setNotices(previous=>previous.filter(item=>item.id !== notice.id));setExpanded(false);}
    } catch {if(mounted.current) setError("That action did not complete. Try again.");}
    finally {locked.current=false;if(mounted.current){setOpening(null);await refreshNotices();}}
  }
  const shares = includeReviews ? view?.shares.filter(share => share.can_open && share.state === "active" && share.connectivity === "online" && Date.parse(share.expires_at) > now + clockOffset) ?? [] : [];
  const count = shares.length + notices.length;
  if ((!includeReviews || !bridge?.notifications || !bridge.openSharedLink) && !noticeBridge) return null;
  return <div ref={container} className="relative" style={{WebkitAppRegion:"no-drag"} as CSSProperties}>
    <button ref={trigger} type="button" aria-label={`Notifications, ${count} unread`} aria-expanded={expanded} aria-controls="beam-review-notifications" title={count ? "New notifications" : "No new notifications"} className="relative flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary hover:bg-white/10 hover:text-ink-heading" onClick={() => {setExpanded(value => !value); setError("");}}>
      <Icon name="bell" size={18} />
      {count > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[9px] font-semibold text-black">{count > 99 ? "99+" : count}</span>}
    </button>
    <span role="status" aria-live="polite" className="sr-only">{count > 0 ? `${count} unread ${count === 1 ? "notification" : "notifications"}.` : ""}</span>
    {expanded && <section id="beam-review-notifications" aria-label="Notifications" className="absolute right-0 top-full z-30 mt-2 max-h-64 w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-line bg-bg p-3 shadow-xl">
    <h2 className="text-xs font-semibold text-ink-heading">Notifications</h2>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    {!count && <p className="mt-2 text-xs text-ink-secondary">No new notifications.</p>}
    {notices.map(notice=><article key={notice.id} className="mt-3 border-t border-line pt-3">
      <div className="flex items-start gap-2"><Icon name={notice.kind === "update_available" ? "refresh-cw" : "shield-alert"} size={16} className="mt-0.5 shrink-0 text-ink-secondary" /><div><h3 className="text-xs font-medium text-ink-heading">{notice.title}</h3><p className="mt-1 text-[11px] leading-4 text-ink-secondary">{notice.body}</p></div></div>
      <button className="mt-2 rounded-lg border border-line px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40" disabled={opening !== null} aria-label={notice.kind === "update_available" ? "Download update" : `Mark ${notice.title} as read`} onClick={()=>void readNotice(notice)}>{opening === notice.id ? "Opening…" : notice.kind === "update_available" ? "Download" : "Mark as read"}</button>
    </article>)}
    {shares.map(share => <article key={share.id} className="mt-3 flex items-center gap-3 border-t border-line pt-3">
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium text-ink-heading">{share.name}</h3>
        <p className="text-[11px] text-ink-secondary">Shared for review</p>
        {share.publisher_name && <p className="text-xs text-ink-secondary">Shared by {share.publisher_name}</p>}
      </div>
      <button className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium hover:bg-white/10 disabled:opacity-40" aria-label={`Open ${share.name} for review`} disabled={opening !== null} onClick={() => void open(share.id)}>{opening === share.id ? "Opening…" : "Open"}</button>
    </article>)}
    </section>}
  </div>;
}
