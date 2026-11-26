import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../lib/desktop";
import { BeamSharedPanel } from "./BeamSharedPanel";
import { Modal } from "../components/ui";
import { Icon } from "../components/Icon";
import "./client-sharing.css";
import {
  audienceLabel,
  createBlockReason,
  extendBlockReason,
  formatDuration,
  formatRemaining,
  hostPort,
  plural,
  publishBlockReason,
  reviewerSummary,
  shareStatus,
  shareStatusHint,
} from "./sharingcopy";
import type {
  BeamAction,
  BeamCreate,
  BeamGrantsImpact,
  BeamShare,
  BeamTarget,
  BeamView,
} from "../lib/beamtypes";

const button = "client-button";
const input = "client-field";
/** Kept for callers of the earlier name; see shareStatus for the wording. */
export const beamStatus = (share: BeamShare, now = Date.now()): string => shareStatus(share, now);
export function beamError(error: unknown): string {
  const text = String(error);
  // Exact server codes first, so a code is never mistaken for a broader pattern.
  if (/\bbeam_quota_reached\b/.test(text))
    return "You've reached your organization's limit of active shares. Stop a share to create another.";
  if (/\bbeam_publisher_denied\b|\bbeam_publishing_denied\b/.test(text))
    return "Your account can open apps shared with you but can't share its own. Ask an administrator for publishing access.";
  if (/\bbeam_unavailable\b/.test(text))
    return "Local Sharing is turned off or its setup isn't finished on your server. Ask an administrator.";
  if (/shared_access_unavailable/i.test(text))
    return "This app is no longer available to your account. Refresh shared apps.";
  if (/organization.*required|organization selection/i.test(text))
    return "Choose your organization in Profiles before sharing.";
  if (/update_required/i.test(text))
    return "Update Tunnex desktop to use Local Sharing with this server.";
  if (/404|unsupported|protocol/i.test(text))
    return "This server does not support Local Sharing yet. Update the server to use sharing.";
  if (/401|403|session_changed|credential|authenticated/i.test(text))
    return "Sign in with an account permitted to publish in this organization.";
  if (/409|conflict|version/i.test(text))
    return "This share changed. Refresh and try again.";
  if (/429|quota|limit/i.test(text))
    return "Your sharing limit was reached. Stop a share or ask your administrator to adjust the policy.";
  if (/app_unavailable|target/i.test(text))
    return "The local app did not respond. Check the selected address, port and TLS trust.";
  if (/denied|disabled|ready|domain/i.test(text))
    return "Local Sharing is unavailable under your organization policy or domain setup.";
  return "Local Sharing could not complete this request. Your saved shares were kept; refresh and try again.";
}
export function BeamPanel() {
  const [tab, setTab] = useState<"mine" | "shared">("mine");
  return <div className="client-sharing">
    <header className="client-sharing-heading">
      <h1>Local Sharing</h1>
      <p>Your local apps. A private link away.</p>
      <span className="client-sharing-vpn-note"><Icon name="check-circle" size={13} /> Works independently of your VPN</span>
    </header>
    <nav aria-label="Local Sharing tabs" className="client-sharing-tabs">
      <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>My shares</button>
      <button type="button" aria-pressed={tab === "shared"} onClick={() => setTab("shared")}>Shared with me</button>
    </nav>
    {tab === "mine" ? <BeamPublisherPanel /> : <BeamSharedPanel />}
  </div>;
}
function BeamPublisherPanel() {
  const bridge = desktop()?.beam;
  const [view, setView] = useState<BeamView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BeamShare | null>(null);
  const [removal, setRemoval] = useState<{
    share: BeamShare;
    grants: BeamCreate["grants"];
    impact: BeamGrantsImpact;
  } | null>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState("3000");
  const [apiPort, setApiPort] = useState("");
  const [apiPrefix, setApiPrefix] = useState("/api");
  const [suggestedPorts, setSuggestedPorts] = useState<number[]>([]);
  const [address, setAddress] = useState<BeamTarget["address"]>("127.0.0.1");
  const [protocol, setProtocol] = useState<BeamTarget["protocol"]>("http");
  const [ca, setCa] = useState("");
  const [duration, setDuration] = useState(7200);
  const [grants, setGrants] = useState<string[]>([]);
  const [check, setCheck] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const refreshSequence = useRef(0);
  const [extending, setExtending] = useState<string | null>(null);
  const [stopping, setStopping] = useState<BeamShare | null>(null);
  const [scan, setScan] = useState("");
  const [extensionSeconds, setExtensionSeconds] = useState(3600);
  const key = useRef<string | null>(null);
  const checkEpoch = useRef(0);
  const mounted = useRef(true);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const target: BeamTarget = {
    address,
    port: Number(port),
    protocol,
    ...(protocol === "https" && ca ? { ca_pem: ca } : {}),
    ...(apiPort ? {routes:[{path_prefix:apiPrefix,target:{address,port:Number(apiPort),protocol,...(protocol === "https" && ca ? {ca_pem:ca} : {})}}]} : {}),
  };
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await bridge.view({ offset, query });
      if (!mounted.current || sequence !== refreshSequence.current) return;
      setView(next);
      setClockOffset(Date.parse(next.server_time) - Date.now());
      setError("");
    } catch (e) {
      if (mounted.current && sequence === refreshSequence.current)
        setError(beamError(e));
    }
  }, [bridge, offset, query]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = bridge?.onChanged(() => void refresh());
    const poll = window.setInterval(() => void refresh(), 5000);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      clearInterval(poll);
      clearInterval(timer);
    };
  }, [bridge, refresh]);
  useEffect(() => {
    checkEpoch.current++;
    setCheck(null);
    key.current = null;
    setScan("");
  }, [address, port, protocol, ca, apiPort, apiPrefix]);
  const run = async <T,>(effect: () => Promise<T>, message?: string | ((result: T) => string | undefined)) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await effect();
      const text = typeof message === "function" ? message(result) : message;
      if (text) setNotice(text);
      await refresh();
    } catch (e) {
      setError(beamError(e));
      await refresh();
      setError(beamError(e));
    } finally {
      setBusy(false);
    }
  };
  const checkApp = async () => {
    if (!bridge) return;
    const epoch = ++checkEpoch.current;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.checkLocal(target);
      if (epoch === checkEpoch.current) setCheck(result.ready);
    } catch (e) {
      setError(beamError(e));
    } finally {
      setBusy(false);
    }
  };
  const suggestPorts = async () => {
    if (!bridge) return;
    const epoch = ++checkEpoch.current;
    setBusy(true); setError(""); setSuggestedPorts([]); setScan("");
    try {
      const ports = [3000, 3001, 5173, 8000, 8080, 4200];
      const results = await Promise.all(ports.map(async port => ({port,ready:(await bridge.checkLocal({address:"127.0.0.1",port,protocol:"http"})).ready})));
      if (mounted.current && epoch === checkEpoch.current) {
        const found = results.filter(result=>result.ready).map(result=>result.port);
        setSuggestedPorts(found);
        setScan(found.length ? `Apps answered on ${plural(found.length, "port")}. Choose one.` : `No app answered on ports ${ports.join(", ")}. Enter your app's port.`);
      }
    } catch (error) {setError(beamError(error));} finally {setBusy(false);}
  };
  const selectedGrants = () =>
    grants.map((value) => {
      const [subject_kind, subject_id] = value.split(":");
      return { subject_kind: subject_kind as "user" | "group", subject_id };
    });
  const create = async () => {
    if (!bridge) return;
    await run(async () => {
      key.current ??= await bridge.idempotencyKey();
      const draft: BeamCreate = {
        name,
        target,
        duration_seconds: duration,
        grants: selectedGrants(),
        idempotency_key: key.current,
      };
      const created = await bridge.create(draft);
      key.current = null;
      setCreating(false);
      setName("");
      return created;
    }, (created) => created?.local_status === "live"
      ? "Share is live. Reviewers can open it after signing in."
      : "Share created. It shows Live in a few seconds; reviewers can open it after signing in.");
  };
  const action = (
    share: BeamShare,
    verb: BeamAction["action"],
    extra: Partial<BeamAction> = {},
  ) => {
    if (!bridge) return;
    void run(
      () =>
        bridge.action({
          id: share.id,
          version: share.version,
          action: verb,
          ...extra,
        }),
      ({
        pause: "Share paused. Reviewers can't open it until you resume it.",
        resume: "Share resumed. It shows Live again in a few seconds.",
        stop: "Share stopped. Create a new share to publish this app again.",
        extend: extra.expires_at ? `Share extended. It now ends at ${new Date(extra.expires_at).toLocaleTimeString()}.` : undefined,
        grants: undefined,
      } as const)[verb],
    );
  };
  const saveAccess = async () => {
    if (!bridge || !editing) return;
    const proposed = selectedGrants();
    await run(async () => {
      const impact = await bridge.previewGrants({
        id: editing.id,
        version: editing.version,
        grants: proposed,
      });
      if (impact.requires_confirmation) {
        setRemoval({ share: editing, grants: proposed, impact });
        return;
      }
      await bridge.action({
        id: editing.id,
        version: impact.share_version,
        action: "grants",
        grants: proposed,
      });
      setEditing(null);
      return "Reviewers updated.";
    }, (message) => message);
  };
  const confirmRemoval = async () => {
    if (!bridge || !removal) return;
    const pending = removal;
    await run(async () => {
      // A rejected/stale confirmation must be previewed again before retrying.
      setRemoval(null);
      await bridge.action({
        id: pending.share.id,
        version: pending.impact.share_version,
        action: "grants",
        grants: pending.grants,
        confirm_reviewer_removal: true,
      });
      setEditing(null);
    }, "Reviewers updated.");
  };
  // Every share that has not ended: paused and offline shares need Resume and Reconnect.
  const visibleShares = view?.shares.filter(share => ["starting", "active", "paused"].includes(share.state) && Date.parse(share.expires_at) > now + clockOffset) ?? [];
  const blockReason = view ? publishBlockReason(view.policy, view.quota) : null;
  const canCreate = !!view && !blockReason;
  const audience = view?.policy.audience ?? [];
  const chosenReviewers = grants.filter(value => audience.some(subject => `${subject.subject_kind}:${subject.subject_id}` === value)).length;
  const keptSelections = editing ? grants.filter(value => value !== `user:${editing.publisher_id}` && !audience.some(subject => `${subject.subject_kind}:${subject.subject_id}` === value)).length : 0;
  const createReason = editing ? null : createBlockReason({name, port, apiPort, apiPrefix, address, check, reviewers: chosenReviewers, available: audience.length});
  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setGrants([]);
    setDuration(Math.min(view?.policy.default_duration_seconds ?? 7200, view?.policy.max_duration_seconds ?? 86400));
    key.current = null;
  };
  return (
    <section aria-label="Local Sharing" className="client-sharing-panel">
      <h2 className="sr-only">My shares</h2>
      {!bridge && (
        <div role="status" className="client-sharing-welcome">
          <div className="client-sharing-welcome-icon"><Icon name="app-window-share" size={30} strokeWidth={1.4} /></div>
          <h3>Bring your local app to the conversation.</h3>
          <p>Share a private link with your team, choose who can open it, and keep control of access.</p>
          <div className="client-sharing-flow" aria-hidden="true"><span>Local app</span><Icon name="chevron-right" size={14} /><span>Private link</span><Icon name="chevron-right" size={14} /><span>Your team</span></div>
          <div className="client-sharing-desktop-hint"><Icon name="monitor" size={16} /><span>Open Tunnex desktop to publish a local app.</span></div>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="client-sharing-feedback client-sharing-feedback-error"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="client-sharing-feedback">
          {notice}
        </p>
      )}
      {bridge && !view && !error && (
        <p role="status" className="client-empty">
          Loading your shares…
        </p>
      )}
      {view && blockReason && (
        <p
          id="beam-publish-reason"
          role="status"
          className="client-sharing-feedback client-sharing-feedback-warning"
        >
          {blockReason}
        </p>
      )}
      {bridge && !creating && !editing && <div className="client-sharing-toolbar">
        {view && <>
          <label className="sr-only" htmlFor="beam-search">Search shares</label>
          <input id="beam-search" className={input} placeholder="Find a share…" value={query} maxLength={120} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} />
        </>}
        <button
          className={button + " client-sharing-refresh"}
          aria-label="Refresh"
          title="Refresh"
          onClick={() => void refresh()}
          disabled={busy || !bridge}
        >
          <Icon name="refresh-cw" size={16} />
        </button>
        <button
          className="client-button-primary"
          onClick={openCreate}
          disabled={busy || !canCreate}
          aria-describedby={blockReason ? "beam-publish-reason" : undefined}
        >
          New share
        </button>
      </div>}
      {view?.quota && !creating && !editing && <p className="client-sharing-inventory-context">{view.quota.active_shares} of {view.quota.max_shares} active shares</p>}
      {(creating || editing) && (
        <section className="client-section client-sharing-editor" aria-label={editing ? "Manage reviewer access" : "Share a local app"}>
          <header className="client-section-header">
          <h2>
            {editing ? "Manage reviewer access" : "Share a local app"}
          </h2>
          <button className={button + " client-sharing-refresh"} aria-label="Refresh" title="Refresh" disabled={busy || !bridge} onClick={() => void refresh()}><Icon name="refresh-cw" size={16} /></button>
          </header>
          <div className="client-section-body">
          {editing && <dl className="client-sharing-facts">
            <div className="client-sharing-fact-wide"><dt>Application</dt><dd>{editing.name}</dd></div>
            <div className="client-sharing-fact-wide"><dt>Shared address</dt><dd className="client-sharing-technical">{editing.hostname}</dd></div>
            <div><dt>Local app</dt><dd className="client-sharing-technical">{editing.target.address}:{editing.target.port}</dd></div>
            <div><dt>Link ends</dt><dd>{new Date(editing.expires_at).toLocaleString()}</dd></div>
            <div className="client-sharing-fact-wide"><dt>Status</dt><dd>{shareStatus(editing, now + clockOffset)}</dd></div>
          </dl>}
          {!editing && (
            <fieldset className="client-sharing-form-group">
              <legend>Local app</legend>
              <label className="client-sharing-label">
                App name
                <input
                  aria-label="App name"
                  className={input + " mt-1"}
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    key.current = null;
                  }}
                  placeholder="Checkout redesign"
                />
              </label>
              <div className="client-sharing-field-pair">
                <label className="client-sharing-label">
                  Local address
                  <select
                    className={input + " mt-1"}
                    value={address}
                    onChange={(e) =>
                      setAddress(e.target.value as BeamTarget["address"])
                    }
                  >
                    <option value="127.0.0.1">127.0.0.1 (IPv4)</option>
                    <option value="::1">::1 (IPv6)</option>
                  </select>
                </label>
                <label className="client-sharing-label">
                  Port
                  <input
                    aria-label="Local port"
                    type="number"
                    min={1}
                    max={65535}
                    className={input + " mt-1"}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
              </div>
              <div className="client-sharing-inline-actions">
                <button className={button} disabled={busy} onClick={()=>void suggestPorts()}>Find local apps</button>
                {suggestedPorts.map(value=><button key={value} className={button} disabled={busy} onClick={()=>{setPort(String(value));setAddress("127.0.0.1");setProtocol("http");}}>Port {value}</button>)}
                {scan && <span role="status" className="client-sharing-help-text">{scan}</span>}
              </div>
              <p className="client-sharing-help-text">Checks six common HTTP ports on this computer only when you click Find local apps.</p>
              {view?.policy.capabilities?.includes("path_routes_v1") && <fieldset className="client-sharing-api-fields">
                <legend>Frontend + API (optional)</legend>
                <div className="client-sharing-field-pair">
                  <label className="client-sharing-label">API path<input aria-label="API path prefix" className={input+" mt-1"} value={apiPrefix} onChange={event=>setApiPrefix(event.target.value)} /></label>
                  <label className="client-sharing-label">API port<input aria-label="API local port" type="number" min={1} max={65535} className={input+" mt-1"} placeholder="8080" value={apiPort} onChange={event=>setApiPort(event.target.value)} /></label>
                </div>
                <p className="client-sharing-help-text">The API uses the same address, protocol and HTTPS trust. Its path is preserved: /api/orders reaches /api/orders on the API port.</p>
              </fieldset>}
              <label className="client-sharing-label">
                Local protocol
                <select
                  className={input + " mt-1"}
                  value={protocol}
                  onChange={(e) =>
                    setProtocol(e.target.value as BeamTarget["protocol"])
                  }
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS (verified TLS)</option>
                </select>
              </label>
              {protocol === "https" && (
                <label className="client-sharing-label">
                  Local CA certificate (optional)
                  <textarea
                    aria-label="Local CA certificate"
                    className={input + " mt-1"}
                    rows={3}
                    value={ca}
                    onChange={(e) => setCa(e.target.value)}
                    placeholder="PEM certificate for your local HTTPS app"
                  />
                </label>
              )}
              <div className="client-sharing-inline-actions">
                <button
                  className={button}
                  disabled={
                    busy ||
                    !Number.isInteger(target.port) ||
                    target.port < 1 ||
                    target.port > 65535 || (apiPort!=="" && (!Number.isInteger(Number(apiPort)) || Number(apiPort)<1 || Number(apiPort)>65535 || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(apiPrefix)))
                  }
                  onClick={() => void checkApp()}
                >
                  Check app
                </button>
                {check !== null && (
                  <span
                    role="status"
                    className={
                      "text-xs " + (check ? "text-emerald-300" : "text-warn")
                    }
                  >
                    {check
                      ? `Your app responded on ${hostPort(address, port)}.`
                      : `Nothing answered on ${hostPort(address, port)}. Start your app or check the port and protocol.`}
                  </span>
                )}
              </div>
            </fieldset>
          )}
          <fieldset className="client-sharing-form-group">
            <legend>Who can review?</legend>
            <div className="client-sharing-audience">
              {audience.map((subject) => {
                const value = `${subject.subject_kind}:${subject.subject_id}`;
                return (
                  <label key={value} className="client-sharing-reviewer">
                    <input type="checkbox" checked={grants.includes(value)} onChange={(e) => {
                      setGrants((current) => e.target.checked ? [...current, value] : current.filter((v) => v !== value));
                      key.current = null;
                    }} />
                    <span>{audienceLabel(subject)}</span>
                  </label>
                );
              })}
            </div>
            {!audience.length && <p className="client-sharing-help-text text-warn">No reviewers are available. Ask an administrator to add reviewers to the Local Sharing policy.</p>}
            {keptSelections > 0 && <p className="client-sharing-help-text">{plural(keptSelections, "other selection")} outside the current reviewer list {keptSelections === 1 ? "is" : "are"} kept.</p>}
            <p className="client-sharing-help-text">You can always open your own shares.</p>
          </fieldset>
          {!editing && <fieldset className="client-sharing-form-group">
            <legend>Availability</legend>
              <label className="client-sharing-label">
                Link lifetime
                <select
                  aria-label="Link lifetime"
                  className={input + " mt-1"}
                  value={duration}
                  onChange={(e) => {
                    setDuration(Number(e.target.value));
                    key.current = null;
                  }}
                >
                  {Array.from(
                    new Set([
                      900,
                      1800,
                      3600,
                      7200,
                      14400,
                      28800,
                      86400,
                      view?.policy.max_duration_seconds ?? 86400,
                      duration,
                    ]),
                  )
                    .sort((a, b) => a - b)
                    .filter(
                      (seconds) =>
                        seconds <= (view?.policy.max_duration_seconds ?? 86400),
                    )
                    .map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {formatDuration(seconds)}
                      </option>
                    ))}
                </select>
              </label>
          </fieldset>}
          <p className="client-sharing-help-text">
            Reviewers sign in before opening this link. Keep Tunnex and your
            local app running. Closing the window keeps active shares in the
            tray; Quit ends sharing.
          </p>
          </div>
          <footer className="client-sharing-editor-footer">
            {createReason && <p id="beam-create-reason" className="client-sharing-help-text client-sharing-reason">{createReason}</p>}
            <button
              className="client-button-primary"
              disabled={busy || !!createReason}
              aria-describedby={createReason ? "beam-create-reason" : undefined}
              onClick={() => {
                if (editing) {
                  void saveAccess();
                } else void create();
              }}
            >
              {busy ? "Working…" : editing ? "Save access" : "Create share"}
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </footer>
        </section>
      )}
      {!creating && !editing && <>
      {view && !visibleShares.length && (
        <div className="client-empty client-sharing-empty">
          <div className="client-sharing-welcome-icon"><Icon name="app-window-share" size={26} strokeWidth={1.4} /></div>
          <p className="client-sharing-empty-title">
            {query || offset
              ? "No shares match this page or search."
              : "No active shares right now."}
          </p>
          <p className="client-sharing-help-text">
            {query || offset
              ? "Clear the search or return to the previous page."
              : "Create a share to get feedback on a local app."}
          </p>
        </div>
      )}
      <div className="client-sharing-list">
      {visibleShares.map((share) => {
        const terminal =
          ["stopped", "expired", "revoked"].includes(share.state) ||
          Date.parse(share.expires_at) <= now + clockOffset;
        const status = shareStatus(share, now + clockOffset);
        const hint = shareStatusHint(status);
        const maxLifetime = view?.policy.max_duration_seconds ?? 86400;
        const extensionRoom = Math.floor(
          (Date.parse(share.created_at) +
            maxLifetime * 1000 -
            Date.parse(share.expires_at)) /
            1000,
        );
        const extensionOptions = Array.from(
          new Set([
            60,
            900,
            1800,
            3600,
            7200,
            14400,
            28800,
            Math.min(3600, extensionRoom),
          ]),
        )
          .filter((value) => value >= 60 && value <= extensionRoom)
          .sort((a, b) => a - b);
        const extendReason = extendBlockReason(extensionRoom, maxLifetime);
        const reasonId = `beam-extend-reason-${share.id}`;
        return (
          <article
            key={share.id}
            className="client-sharing-row"
          >
            <div className="client-sharing-row-heading">
              <h3>
                {share.name}
              </h3>
              <span
                role="status"
                className={
                  "client-status client-sharing-live " +
                  (status === "Live"
                    ? "client-sharing-live-ready"
                    : "text-ink-secondary")
                }
              >
                {status}
              </span>
            </div>
            <p className="client-sharing-hostname">
              {share.hostname}
            </p>
            <p className="client-sharing-row-context">
              {reviewerSummary(share, audience)}
            </p>
            <p className="client-sharing-row-context client-sharing-technical">
              Local app {share.target.protocol}://{hostPort(share.target.address, share.target.port)}
            </p>
            <p
              className="client-sharing-row-context"
              title={share.expires_at}
            >
              {terminal
                ? `Ended · ${new Date(share.expires_at).toLocaleString()}`
                : `Expires in ${formatRemaining(Date.parse(share.expires_at) - now - clockOffset)} · ${new Date(share.expires_at).toLocaleTimeString()}`}
            </p>
            <div className="client-sharing-row-actions">
              <button
                className={button + " client-sharing-quiet-action"}
                disabled={busy || terminal}
                onClick={() =>
                  void run(() => bridge!.copyLink(share.id), "Link copied. Reviewers still need access and sign-in.")
                }
              >
                Copy link
              </button>
              <button
                className={button + " client-sharing-open"}
                disabled={busy || terminal || status !== "Live"}
                onClick={() => void run(() => bridge!.openLink(share.id))}
              >
                Open
              </button>
              {!terminal && (
                <>
                  <button
                    className={button + " client-sharing-quiet-action"}
                    disabled={busy}
                    onClick={() =>
                      action(
                        share,
                        share.state === "paused" ? "resume" : "pause",
                      )
                    }
                  >
                    {share.state === "paused" ? "Resume" : "Pause"}
                  </button>
                  {["active", "starting"].includes(share.state) &&
                    share.local_status === "offline" && (
                      <button
                        className={button + " client-sharing-quiet-action"}
                        disabled={busy}
                        onClick={() => void run(() => bridge!.retry(share.id))}
                      >
                        Reconnect
                      </button>
                    )}
                  <button
                    className={button + " client-sharing-quiet-action"}
                    disabled={busy}
                    onClick={() => {
                      setCreating(false);
                      setEditing(share);
                      setGrants(
                        share.grants.map(
                          (g) => `${g.subject_kind}:${g.subject_id}`,
                        ),
                      );
                    }}
                  >
                    Access
                  </button>
                  <button
                    className={button + " client-sharing-quiet-action"}
                    disabled={busy || !!extendReason}
                    aria-describedby={extendReason ? reasonId : undefined}
                    onClick={() => {
                      setExtending(share.id);
                      setExtensionSeconds(
                        Math.max(
                          ...extensionOptions.filter((value) => value <= 3600),
                        ),
                      );
                    }}
                  >
                    Extend
                  </button>
                  <button
                    className={button + " client-sharing-quiet-action client-sharing-danger"}
                    disabled={busy}
                    onClick={() => setStopping(share)}
                  >
                    Stop
                  </button>
                </>
              )}
            </div>
            {extending === share.id && !terminal && (
              <div className="client-sharing-extension">
                <label className="client-sharing-label">
                  Add time
                  <select
                    aria-label="Add share time"
                    className={input + " mt-1"}
                    value={extensionSeconds}
                    onChange={(event) =>
                      setExtensionSeconds(Number(event.target.value))
                    }
                  >
                    {extensionOptions.map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {formatDuration(seconds)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    action(share, "extend", {
                      expires_at: new Date(
                        Date.parse(share.expires_at) + extensionSeconds * 1000,
                      ).toISOString(),
                    });
                    setExtending(null);
                  }}
                >
                  Confirm extension
                </button>
                <button className={button} onClick={() => setExtending(null)}>
                  Cancel
                </button>
              </div>
            )}
            {hint && (
              <p className={"client-sharing-help-text" + (status === "App not responding" || status === "Offline" ? " text-warn" : "")}>
                {hint}
              </p>
            )}
            {extendReason && !terminal && (
              <p id={reasonId} className="client-sharing-help-text">
                {extendReason}
              </p>
            )}
          </article>
        );
      })}
      </div>
      {view?.page && (offset > 0 || view.page.has_next) && (
        <div
          className="client-sharing-pagination"
          aria-label="Share pages"
        >
          <button
            className={button}
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - view.page!.limit))}
          >
            Previous shares
          </button>
          <span className="text-xs text-ink-secondary">
            Page {Math.floor(offset / view.page.limit) + 1}
          </span>
          <button
            className={button}
            disabled={
              busy || !view.page.has_next || offset + view.page.limit > 10000
            }
            onClick={() => setOffset(offset + view.page!.limit)}
          >
            Next shares
          </button>
        </div>
      )}
      </>}
      <details className="client-sharing-disclosure client-sharing-help">
        <summary>
          App compatibility and sharing help
        </summary>
        <div className="client-sharing-disclosure-body">
        <p>
          Use a web app served from its root path on the selected loopback
          address and port. Changing the target requires a new share. HTTPS
          needs a valid certificate or the local app’s CA certificate.
        </p>
        <p>
          For Vite or another development server, allow the exact sharing hostname
          in its allowed-host configuration and configure its public WebSocket
          URL if needed. Local Sharing preserves WebSocket subprotocols and streams SSE;
          WebSocket compression isn’t supported yet.
        </p>
        <p>
          Uploads and HTTP responses are limited to 16 MiB. WebSocket frames are
          limited to 1 MiB and fragmented messages to 16 MiB. Cookies must stay
          on this app’s host; external redirects and broad cookie domains are
          rejected.
        </p>
        <p>
          Keep your app and Tunnex running. Closing the desktop window keeps
          active shares in the tray. Quit ends sharing and stops your shares.
          If Tunnex loses its connection, choose Reconnect on the share. An
          ended share needs a new share.
        </p>
        </div>
      </details>
      {removal && (
        <Modal
          title="Confirm reviewer access removal"
          danger
          onDismiss={() => {
            if (!busy) setRemoval(null);
          }}
          actions={
            <div className="client-sharing-confirmation-actions">
              <button
                className={button}
                disabled={busy}
                onClick={() => setRemoval(null)}
              >
                Cancel removal
              </button>
              <button
                className={button + " border-danger/50"}
                disabled={busy}
                onClick={() => void confirmRemoval()}
              >
                Remove access
              </button>
            </div>
          }
        >
          <p className="text-sm text-ink-secondary">
            {`This removes ${plural(removal.impact.removed_grant_count, "reviewer selection")} from ${removal.share.name}.`}
          </p>
          <p className="mt-3 text-sm text-ink-secondary">
            {`${plural(removal.impact.affected_reviewer_count, "person", "people")} will lose access, and ${plural(removal.impact.affected_reviewer_session_count, "open session")} will end.`}
          </p>
        </Modal>
      )}
      {stopping && (
        <Modal
          title="Stop this share"
          danger
          onDismiss={() => {
            if (!busy) setStopping(null);
          }}
          actions={
            <div className="client-sharing-confirmation-actions">
              <button className={button} disabled={busy} onClick={() => setStopping(null)}>
                Keep sharing
              </button>
              <button
                className={button + " border-danger/50"}
                disabled={busy}
                onClick={() => {
                  const share = stopping;
                  setStopping(null);
                  action(share, "stop");
                }}
              >
                Confirm stop
              </button>
            </div>
          }
        >
          <p className="text-sm text-ink-secondary">
            {`Stop ${stopping.name} permanently? Reviewers lose access right away. To share the app again, create a new share.`}
          </p>
        </Modal>
      )}
    </section>
  );
}
