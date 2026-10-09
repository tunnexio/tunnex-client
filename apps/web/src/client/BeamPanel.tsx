import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../lib/desktop";
import { BeamSharedPanel } from "./BeamSharedPanel";
import { Modal } from "../components/ui";
import { Icon } from "../components/Icon";
import "./client-sharing.css";
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
export function beamStatus(share: BeamShare, now = Date.now()): string {
  if (Date.parse(share.expires_at) <= now) return "Expired";
  if (!["active", "starting"].includes(share.state))
    return share.state[0].toUpperCase() + share.state.slice(1);
  return (
    {
      live: "Live",
      starting: "Connecting",
      reconnecting: "Reconnecting",
      offline: "Offline",
      app_unavailable: "App unavailable",
    } as const
  )[share.local_status ?? "offline"];
}
export function beamError(error: unknown): string {
  const text = String(error);
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
      <p>Works independently of your VPN connection.</p>
    </header>
    <nav aria-label="Beam shares" className="client-sharing-tabs">
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
  }, [address, port, protocol, ca, apiPort, apiPrefix]);
  const run = async (effect: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await effect();
      if (message) setNotice(message);
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
    setBusy(true); setError(""); setSuggestedPorts([]);
    try {
      const ports = [3000, 3001, 5173, 8000, 8080, 4200];
      const results = await Promise.all(ports.map(async port => ({port,ready:(await bridge.checkLocal({address:"127.0.0.1",port,protocol:"http"})).ready})));
      if (mounted.current && epoch === checkEpoch.current) {setSuggestedPorts(results.filter(result=>result.ready).map(result=>result.port));setNotice(results.some(result=>result.ready) ? "Select a responding port below." : "No HTTP apps responded on the six common ports. Enter your app port manually.");}
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
      await bridge.create(draft);
      key.current = null;
      setCreating(false);
      setName("");
    }, "Share created. Availability follows the connector status below.");
  };
  const action = (
    share: BeamShare,
    verb: BeamAction["action"],
    extra: Partial<BeamAction> = {},
  ) => {
    if (!bridge) return;
    if (
      verb === "stop" &&
      !window.confirm(
        "Stop this share permanently? Open reviewer sessions will end. Create a new share to publish again.",
      )
    )
      return;
    void run(
      () =>
        bridge.action({
          id: share.id,
          version: share.version,
          action: verb,
          ...extra,
        }),
      verb === "pause"
        ? "Share paused. Reviewers cannot open the app."
        : undefined,
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
    });
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
    }, "Reviewer access updated.");
  };
  const liveShares = view?.shares.filter(share => share.state === "active" && share.local_status === "live" && Date.parse(share.expires_at) > now + clockOffset) ?? [];
  const canCreate =
    !!view?.policy.enabled &&
    view.policy.domain_ready &&
    view.policy.can_publish;
  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setGrants([]);
    setDuration(view?.policy.default_duration_seconds ?? 7200);
    key.current = null;
  };
  return (
    <section aria-label="Tunnex Beam" className="client-sharing-panel">
      <h2 className="sr-only">My shares</h2>
      {!bridge && (
        <p role="status" className="client-empty">
          Open Tunnex desktop to publish a local app.
        </p>
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
          Loading your sharing policy…
        </p>
      )}
      {view && !canCreate && (
        <p
          role="status"
          className="client-sharing-feedback client-sharing-feedback-warning"
        >
          {view.policy.reason ||
            "Your administrator needs to enable Local Sharing and allow publishing for your account."}
        </p>
      )}
      {!creating && !editing && <div className="client-sharing-toolbar">
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
        >
          New share
        </button>
      </div>}
      {view?.quota && !creating && !editing && <p className="client-sharing-inventory-context">{view.quota.active_shares} / {view.quota.max_shares} active shares</p>}
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
                  Loopback address
                  <select
                    className={input + " mt-1"}
                    value={address}
                    onChange={(e) =>
                      setAddress(e.target.value as BeamTarget["address"])
                    }
                  >
                    <option>127.0.0.1</option>
                    <option>::1</option>
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
                    {check ? "App responded" : "App unavailable"}
                  </span>
                )}
              </div>
            </fieldset>
          )}
          <fieldset className="client-sharing-form-group">
            <legend>Who can review?</legend>
            <div className="client-sharing-audience">
              {view?.policy.audience.map((subject) => {
                const value = `${subject.subject_kind}:${subject.subject_id}`;
                return (
                  <label key={value} className="client-sharing-reviewer">
                    <input type="checkbox" checked={grants.includes(value)} onChange={(e) => {
                      setGrants((current) => e.target.checked ? [...current, value] : current.filter((v) => v !== value));
                      key.current = null;
                    }} />
                    <span>{subject.name}</span>
                    <span className="client-sharing-reviewer-kind">{subject.subject_kind}</span>
                  </label>
                );
              })}
            </div>
            {!view?.policy.audience.length && <p className="client-sharing-help-text text-warn">No permitted reviewers. Ask your administrator to configure the reviewer audience.</p>}
          </fieldset>
          {!editing && <fieldset className="client-sharing-form-group">
            <legend>Availability</legend>
              <label className="client-sharing-label">
                Link lifetime
                <select
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
                        {seconds < 3600
                          ? `${seconds / 60} minutes`
                          : `${seconds / 3600} hours`}
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
            <button
              className="client-button-primary"
              disabled={
                busy ||
                (!editing && !grants.length) ||
                (!editing && (!name.trim() || check !== true))
              }
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
      {view && !liveShares.length && (
        <div className="client-empty client-sharing-empty">
          <p className="client-sharing-empty-title">
            {query || offset
              ? "No live shares match this page or search."
              : "No live shares right now."}
          </p>
          <p className="client-sharing-help-text">
            {query || offset
              ? "Clear the search or return to the previous page."
              : "Create a share to get feedback on a local app."}
          </p>
        </div>
      )}
      <div className="client-sharing-list">
      {liveShares.map((share) => {
        const terminal =
          ["stopped", "expired", "revoked"].includes(share.state) ||
          Date.parse(share.expires_at) <= now + clockOffset;
        const remaining = Math.max(
          0,
          Math.ceil((Date.parse(share.expires_at) - now - clockOffset) / 60000),
        );
        const status = beamStatus(share, now + clockOffset);
        const extensionRoom = Math.floor(
          (Date.parse(share.created_at) +
            (view?.policy.max_duration_seconds ?? 86400) * 1000 -
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
              {share.target.protocol} · {share.target.address}:
              {share.target.port} · {share.grants.length} audience rule
              {share.grants.length === 1 ? "" : "s"}
            </p>
            <p
              className="client-sharing-row-context"
              title={share.expires_at}
            >
              {terminal
                ? `Ended · ${new Date(share.expires_at).toLocaleString()}`
                : `Expires in ${remaining} min · ${new Date(share.expires_at).toLocaleTimeString()}`}
            </p>
            <div className="client-sharing-row-actions">
              <button
                className={button + " client-sharing-quiet-action"}
                disabled={busy || terminal}
                onClick={() =>
                  void run(() => bridge!.copyLink(share.id), "Link copied.")
                }
              >
                Copy link
              </button>
              <button
                className={button + " client-sharing-open"}
                disabled={busy || terminal}
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
                  {share.state === "active" &&
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
                    disabled={busy || extensionRoom < 60}
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
                    onClick={() => action(share, "stop")}
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
                        {seconds / 60} minutes
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
            {share.local_status === "app_unavailable" && (
              <p className="client-sharing-help-text text-warn">
                Start your app on the same address and port. Your link and
                expiry stay the same.
              </p>
            )}
            {terminal && (
              <p className="client-sharing-help-text">
                Create a new share to publish this app again.
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
          For Vite or another development server, allow the exact Beam hostname
          in its allowed-host configuration and configure its public WebSocket
          URL if needed. Beam preserves WebSocket subprotocols and streams SSE;
          WebSocket compression is unavailable in v1.
        </p>
        <p>
          Uploads and HTTP responses are limited to 16 MiB. WebSocket frames are
          limited to 1 MiB and fragmented messages to 16 MiB. Cookies must stay
          on this app’s host; external redirects and broad cookie domains are
          rejected.
        </p>
        <p>
          Keep your app and Tunnex running. Closing the desktop window keeps
          active shares in the tray. Quit ends sharing. After a full restart,
          choose Reconnect for an eligible share; terminal links require a new
          share.
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
            Remove {removal.impact.removed_grant_count} audience rule(s) from{" "}
            {removal.share.name}?
          </p>
          <p className="mt-3 text-sm text-ink-secondary">
            {removal.impact.affected_reviewer_count} reviewer(s) and{" "}
            {removal.impact.affected_reviewer_session_count} signed-in
            session(s) will lose access. Open sessions that lose permission will
            end.
          </p>
        </Modal>
      )}
    </section>
  );
}
