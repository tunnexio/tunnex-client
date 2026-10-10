import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { desktop, type ClientNotice } from "../lib/desktop";
import type { BeamSharedView } from "../lib/beamtypes";
import { beamError } from "./BeamPanel";
import "./client-sharing.css";

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
  return <div ref={container} className="client-notifications" style={{WebkitAppRegion:"no-drag"} as CSSProperties}>
    <button ref={trigger} type="button" aria-label={`Notifications, ${count} unread`} aria-expanded={expanded} aria-controls="beam-review-notifications" title={count ? "New notifications" : "No new notifications"} className="client-notifications-trigger" onClick={() => {setExpanded(value => !value); setError("");}}>
      <Icon name="bell" size={18} />
      {count > 0 && <span aria-hidden className="client-notifications-count">{count > 99 ? "99+" : count}</span>}
    </button>
    <span role="status" aria-live="polite" className="sr-only">{count > 0 ? `${count} unread ${count === 1 ? "notification" : "notifications"}.` : ""}</span>
    {expanded && <section id="beam-review-notifications" aria-label="Notifications" className="client-notifications-panel">
    <h2>Notifications</h2>
    {error && <p role="alert" className="client-notifications-error">{error}</p>}
    {!count && <p className="client-notifications-empty">No new notifications.</p>}
    {notices.map(notice=><article key={notice.id} className="client-notifications-item">
      <div><h3>{notice.title}</h3><p>{notice.body}</p></div>
      <button className="client-button client-notifications-action" disabled={opening !== null} aria-label={notice.kind === "update_available" ? "Download update" : `Mark ${notice.title} as read`} onClick={()=>void readNotice(notice)}>{opening === notice.id ? "Opening…" : notice.kind === "update_available" ? "Download" : "Mark as read"}</button>
    </article>)}
    {shares.map(share => <article key={share.id} className="client-notifications-item client-notifications-review">
      <div><h3>{share.name}</h3>
        <p>Shared for review</p>
        {share.publisher_name && <p>Shared by {share.publisher_name}</p>}
      </div>
      <button className="client-button client-notifications-action" aria-label={`Open ${share.name} for review`} disabled={opening !== null} onClick={() => void open(share.id)}>{opening === share.id ? "Opening…" : "Open"}</button>
    </article>)}
    </section>}
  </div>;
}
