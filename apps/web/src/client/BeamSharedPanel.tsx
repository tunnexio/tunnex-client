import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../lib/desktop";
import type { BeamSharedView } from "../lib/beamtypes";
import { beamError } from "./BeamPanel";

const button = "rounded-lg border border-line px-3 py-2 text-xs font-medium hover:bg-white/10 disabled:opacity-40";
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
  return <section aria-label="Apps shared with me" className="flex flex-col gap-4">
    <div className="rounded-2xl border border-line bg-white/[.025] p-4">
      <h1 className="text-xl font-semibold text-ink-heading">Shared with me</h1>
      <p className="mt-2 text-xs leading-5 text-ink-secondary">Live apps your teammates have shared with your account or groups.</p>
      <p className="mt-2 text-xs text-ink-secondary">Apps open in your browser. Sign in there if needed; access is checked again when you open the link.</p>
    </div>
    {!bridge?.shared || !bridge?.openSharedLink ? <p role="status" className="text-sm text-ink-secondary">Restart the updated desktop client to load Shared with me.</p> : <>
      {error && <p role="alert" className="rounded-lg border border-danger/30 p-3 text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2"><label className="sr-only" htmlFor="beam-shared-search">Search shared apps</label><input id="beam-shared-search" className="w-full rounded-lg border border-line bg-black/20 px-3 py-2 text-sm text-ink-heading" placeholder="Find a shared app…" value={query} maxLength={120} onChange={event=>{setQuery(event.target.value);setOffset(0);}} /><button className={button} onClick={()=>void refresh()}>Refresh</button></div>
      {!view && !error && <p role="status" className="text-xs text-ink-secondary">Loading shared apps…</p>}
      {view && !shares.length && <p role="status" className="rounded-xl border border-dashed border-line p-4 text-sm text-ink-secondary">{query || offset ? "No live shared apps match this page or search." : "No live apps are currently shared with you."}</p>}
      {shares.map(share=><article key={share.id} className="rounded-xl border border-line bg-white/[.025] p-3">
        <div className="flex items-center gap-2"><h2 className="text-sm font-semibold text-ink-heading">{share.name}</h2><span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">Live</span></div>
        <p className="mt-2 break-all font-mono text-[10px] text-ink-secondary">{share.hostname}</p>
        {share.publisher_name && <p className="mt-2 text-xs text-ink-secondary">Shared by {share.publisher_name}</p>}
        <p className="mt-2 text-xs text-ink-secondary">Expires in {Math.max(0,Math.ceil((Date.parse(share.expires_at)-now-clockOffset)/60000))} min</p>
        <button className={button+" mt-3"} disabled={opening !== null} onClick={()=>void open(share.id)}>{opening===share.id ? "Opening…" : `Open ${share.name} in browser`}</button>
      </article>)}
      {view && <div aria-label="Shared app pages" className="flex items-center justify-between gap-2"><button className={button} disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-view.page.limit))}>Previous apps</button><span className="text-xs text-ink-secondary">Page {Math.floor(offset/view.page.limit)+1}</span><button className={button} disabled={!view.page.has_next} onClick={()=>setOffset(offset+view.page.limit)}>Next apps</button></div>}
    </>}
  </section>;
}
