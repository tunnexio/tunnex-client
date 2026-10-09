import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../lib/desktop";
import type { BeamSharedView } from "../lib/beamtypes";
import { beamError } from "./BeamPanel";
import { Icon } from "../components/Icon";
import "./client-sharing.css";

const button = "client-button";
export function BeamSharedPanel() {
  const bridge = desktop()?.beam;
  const [view, setView] = useState<BeamSharedView | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  const refresh = useCallback(async () => {
    if (!bridge?.shared) return;
    const revision = ++sequence.current;
    try {
      const next = await bridge.shared({offset, query});
      if (!mounted.current || revision !== sequence.current) return;
      setView(next); setClockOffset(Date.parse(next.server_time) - Date.now()); setError("");
    } catch (failure) {
      if (mounted.current && revision === sequence.current) setError(beamError(failure));
    }
  }, [bridge, offset, query]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const unsubscribe = bridge?.onChanged(() => void refresh());
    const poll = window.setInterval(() => void refresh(), 5000);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; sequence.current++; unsubscribe?.(); clearInterval(poll); clearInterval(timer); };
  }, [bridge, refresh]);
  async function open(id: string) {
    if (locked.current || !bridge?.openSharedLink) return;
    locked.current = true; setOpening(id); setError("");
    let failureMessage = "";
    try { await bridge.openSharedLink(id); }
    catch (failure) { failureMessage = beamError(failure); }
    finally {
      locked.current = false;
      if (mounted.current) {setOpening(null); await refresh(); if (mounted.current && failureMessage) setError(failureMessage);}
    }
  }
  const shares = view?.shares.filter(share => share.can_open && share.state === "active" && share.connectivity === "online" && Date.parse(share.expires_at) > now + clockOffset) ?? [];
  return <section aria-label="Apps shared with me" className="client-sharing-panel">
    <h2 className="sr-only">Shared with me</h2>
    {!bridge?.shared || !bridge?.openSharedLink ? <p role="status" className="client-empty">Restart the updated desktop client to load Shared with me.</p> : <>
      {error && <p role="alert" className="client-sharing-feedback client-sharing-feedback-error">{error}</p>}
      <div className="client-sharing-toolbar">
        <label className="sr-only" htmlFor="beam-shared-search">Search shared apps</label>
        <input id="beam-shared-search" className="client-field" placeholder="Find a shared app…" value={query} maxLength={120} onChange={event=>{setQuery(event.target.value);setOffset(0);}} />
        <button className={button+" client-sharing-refresh"} aria-label="Refresh" title="Refresh" onClick={()=>void refresh()}><Icon name="refresh-cw" size={16} /></button>
      </div>
      <p className="client-sharing-help-text">Apps open in your browser. Sign in there if needed; access is checked again when you open the link.</p>
      {!view && !error && <p role="status" className="client-empty">Loading shared apps…</p>}
      {view && !shares.length && <p role="status" className="client-empty client-sharing-empty">{query || offset ? "No live shared apps match this page or search." : "No live apps are currently shared with you."}</p>}
      <div className="client-sharing-list">
      {shares.map(share=><article key={share.id} className="client-sharing-row client-sharing-shared-row">
        <div className="client-sharing-row-heading"><h3>{share.name}</h3><span className="client-status client-sharing-live client-sharing-live-ready">Live</span></div>
        <p className="client-sharing-hostname">{share.hostname}</p>
        <div className="client-sharing-shared-footer">
          <div>
            {share.publisher_name && <p className="client-sharing-row-context">Shared by {share.publisher_name}</p>}
            <p className="client-sharing-row-context" title={share.expires_at}>Expires in {Math.max(0,Math.ceil((Date.parse(share.expires_at)-now-clockOffset)/60000))} min</p>
          </div>
          <button className={button+" client-sharing-open"} aria-label={`Open ${share.name} in browser`} disabled={opening !== null} onClick={()=>void open(share.id)}>{opening===share.id ? "Opening…" : "Open"}</button>
        </div>
      </article>)}
      </div>
      {view && (offset > 0 || view.page.has_next) && <div aria-label="Shared app pages" className="client-sharing-pagination"><button className={button} disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-view.page.limit))}>Previous apps</button><span>Page {Math.floor(offset/view.page.limit)+1}</span><button className={button} disabled={!view.page.has_next} onClick={()=>setOffset(offset+view.page.limit)}>Next apps</button></div>}
    </>}
  </section>;
}
