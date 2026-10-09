import { BeamPanel } from "./BeamPanel";
import { BeamReviewNotifications } from "./BeamReviewNotifications";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  formatBytes,
  formatDuration,
  formatRate,
  parsePreviewState,
  postureCheckSummary,
  stateView,
  trayAppearance,
  type ClientState,
} from "../lib/clientstate";
import {
  desktop,
  type AppInfo,
  type ImportedProfile,
  type ManagedOrganization,
  type ManagedOrganizationEnvelope,
  type ReleaseCheck,
} from "../lib/desktop";
import { Logo, Tagline } from "../brand";
import { Icon } from "../components/Icon";
import "./client-workspace.css";
import { drawGraph, pushRate, rateBetween } from "./throughput";
import {
  createHyperState,
  drawHyper,
  stepLink,
  type HyperMode,
} from "./hyperdrive";

const REMOVE_DEVICE_RETRY_MESSAGE =
  "Device removal did not finish. The saved enrollment was kept; try Remove device again or check Logs.";
const FOREIGN_ENROLLMENT_MESSAGE =
  "An unfinished enrollment belongs to another account. Sign out, then sign in with the account that started it and use Connect to resume recovery.";

/**
 * ClientApp — the desktop client's whole UI.
 *
 * Home owns the connection controls and the one-time Beam review inbox.
 *
 * It mounts NO router and imports NO page. The only shared code is tokens (index.css), the
 * formatting helpers, and the desktop bridge type.
 */
export function ClientApp() {
  const preview = useMemo(() => parsePreviewState(window.location.search), []);
  const previewIPv6 = useMemo(() => new URLSearchParams(window.location.search).get("ip") === "ipv6", []);
  const [live, setLive] = useState<ClientState>("disconnected");
  const [postureFailures, setPostureFailures] = useState<Array<{ kind: string; mode: string }>>([]);
  const [fullTunnel, setFullTunnel] = useState(false);
  const [showActionHint, setShowActionHint] = useState(true);
  // ⛔ REAL COUNTERS NOW, AND THE `n/a` IS NO LONGER PERMANENT. These were hard-wired to null with
  // a comment saying they would arrive "in step 3"; step 3 came and went and they never did, so the
  // panel showed `n/a` in every field forever while the plot beside it drew invented traffic.
  //
  // rx/tx/handshake come from the helper's `wg show` through the bridge. There is no PACKET counter
  // anywhere in that chain — helper, protocol or preload — so that row was a field that could never
  // be filled, and it is gone rather than reserved.
  const [stats, setStats] = useState<{
    rate: number | null;
    peak: number;
    rx: number | null;
    tx: number | null;
    since: number | null;
    handshakeSec: number | null;
    connectionPath: string | null;
    address: string | null;
    history: number[];
  }>({
    rate: null,
    peak: 0,
    rx: null,
    tx: null,
    since: null,
    handshakeSec: null,
    connectionPath: null,
    address: null,
    history: [],
  });

  const state = preview ?? live;
  const view = stateView(state);
  const tray = trayAppearance(state);
  const postureReason = postureCheckSummary(postureFailures);

  // ⛔ THE SURFACE ASKED THE TUNNEL AND NEVER ASKED THE SESSION.
  //
  // It called `tunnel.status()` alone, so a device with NO CREDENTIAL rendered "Disconnected" —
  // a healthy-looking idle state — with a Connect button. Pressing it threw `not_authenticated`
  // from main, unhandled, into a terminal log. The renderer showed nothing at all.
  //
  // Auth is read FIRST and WINS: signed-out is not a kind of disconnected, it is the reason
  // connecting cannot be attempted. `expired` maps to the design's own EXPIRED CREDS.
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (state !== "disconnected" || busy) {
      setShowActionHint(false);
      return;
    }
    let hideTimer = 0;
    let repeatTimer = 0;
    const cycle = () => {
      setShowActionHint(true);
      hideTimer = window.setTimeout(() => {
        setShowActionHint(false);
        repeatTimer = window.setTimeout(cycle, 9000);
      }, 4500);
    };
    cycle();
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(repeatTimer);
    };
  }, [busy, state]);

  function showProblem(error: unknown, message = clientErrorMessage(error)): void {
    // Keep the implementation detail in the client log / developer console. The
    // on-screen surface is a VPN control, not an IPC diagnostic.
    console.error("Tunnex client action failed", error);
    setProblem(message);
  }

  async function refreshAuth(): Promise<boolean> {
    const d = desktop();
    if (!d) return true;
    try {
      const st = await d.auth.status();
      setIdentity(st.fingerprint ?? null);
      const ok = st.loggedIn && !st.expired;
      setAuthed(ok);
      // Main truthfully reports expired credentials as loggedIn=false plus the
      // more specific expired=true. Specific terminal reason wins over the
      // generic absence state.
      if (st.expired) setLive("expired_creds");
      else if (!st.loggedIn) setLive("signed_out");
      return ok;
    } catch {
      // ⚠ A FAILED READ IS NOT "SIGNED OUT". Claiming signed-out on an unreadable session would
      // invite a pointless re-login; the same absent-until-known rule the nav counts follow.
      setAuthed(null);
      return true;
    }
  }

  useEffect(() => {
    const d = desktop();
    if (!d || preview) return;
    void d.config
      .getServerUrl()
      .then(setServerUrl)
      .catch(() => {});
    void d.diag
      .appInfo()
      .then(setAppInfo)
      .catch(() => {});
    // Discovery is read-only: it may surface an available release, but never downloads
    // or installs it. The user still chooses Download from the official site.
    void d.diag
      .checkRelease()
      .then(setReleaseCheck)
      .catch(() => {});
    const releasePoll = window.setInterval(()=>{void d.diag.checkRelease().then(setReleaseCheck).catch(()=>{});}, 6 * 60 * 60 * 1000);
    void d.tunnel
      .importedProfiles()
      .then(setImportedProfiles)
      .catch(() => {});
    void loadManagedOrganizations();
    void (async () => {
      const ok = await refreshAuth();
      if (ok) applyTunnelStatus(await d.tunnel.status());
    })();
    const stopStatus = d.tunnel.onStatusChanged(applyTunnelStatus);
    const stopOrganizationSelection = d.tunnel.onOrganizationSelectionRequired(
      () => {
        setPane("profiles");
        setDrawerOpen(false);
        setOrganizationNotice(
          "Choose an organization before connecting. Tunnex will not guess when your account belongs to more than one.",
        );
        void loadManagedOrganizations();
      },
    );
    return () => {
      stopStatus();
      stopOrganizationSelection();
      window.clearInterval(releasePoll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  function applyTunnelStatus(s: { state?: string; last_handshake_sec?: number; failed_checks?: Array<{ kind: string; mode: string }> }): void {
    setLive(mapStatus(s));
    setPostureFailures(s.failed_checks ?? []);
  }

  // A failed mutation can still have a confirmed first half: main may have
  // brought the helper down before a later revoke, keychain, or profile write
  // failed. Re-read the authoritative helper state so a rejected Promise never
  // leaves a stale Connected label. A failed read is inconclusive and therefore
  // preserves the last pushed/known state.
  async function reconcileTunnelStateAfterFailure(): Promise<void> {
    const d = desktop();
    if (!d) return;
    try {
      applyTunnelStatus(await d.tunnel.status());
    } catch {
      /* keep the last pushed state */
    }
  }

  async function refreshServerUrlAfterFailure(): Promise<void> {
    const d = desktop();
    if (!d) return;
    try {
      setServerUrl(await d.config.getServerUrl());
    } catch {
      /* keep the last server value that was actually read */
    }
  }

  /**
   * ⛔ THE STATS POLL. `onStatusChanged` fires on TRANSITIONS; byte counters change continuously,
   * so a surface driven only by transitions shows the numbers from the moment of connection and
   * then never moves. Polling is the right instrument here precisely because nothing pushes.
   *
   * The rate is a DELTA between readings, not a field — no counter reports bytes/sec.
   */
  const prevCounter = useRef<{ bytes: number; at: number } | null>(null);
  useEffect(() => {
    const d = desktop();
    if (!d || preview) return;
    let stop = false;
    const tick = async () => {
      try {
        const st = await d.tunnel.status();
        if (stop) return;
        // Warn mode leaves the tunnel up. It must keep reporting real counters and
        // animating the live connection rather than look disconnected.
        const up = st?.state === "up" || st?.state === "posture_warning";
        if (!up) {
          // Down: drop the baseline and the clock. Keeping them would make the next connection
          // report a rate computed across the gap and a duration that includes it.
          prevCounter.current = null;
          setStats((p) => ({
            ...p,
            rate: null,
            rx: null,
            tx: null,
            since: null,
            handshakeSec: null,
            connectionPath: null,
            address: null,
            history: [],
          }));
          return;
        }
        const bytes = (st.rx_bytes ?? 0) + (st.tx_bytes ?? 0);
        const now = { bytes, at: Date.now() };
        const rate = rateBetween(prevCounter.current, now);
        prevCounter.current = now;
        setStats((p) => ({
          rate,
          peak: Math.max(p.peak, rate),
          rx: st.rx_bytes ?? null,
          tx: st.tx_bytes ?? null,
          since: p.since ?? Date.now(),
          handshakeSec: st.last_handshake_sec ?? null,
          connectionPath: connectionPathLabel(st.connection_path),
          address: st.address ?? null,
          history: pushRate(p.history, rate),
        }));
      } catch {
        /* a failed poll is not a state change — the last known numbers stand */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [preview]);

  // Browser preview has no helper. Seed the connected review state with representative values so
  // metric hierarchy is reviewed under the same density users see on a live tunnel.
  const displayStats = preview === "connected"
    ? {
        rate: 5832,
        peak: 7740,
        rx: 128_480_256,
        tx: 48_263_168,
        since: Date.now() - 3_726_000,
        handshakeSec: Math.floor(Date.now() / 1000) - 7,
        connectionPath: "Direct",
        address: previewIPv6 ? "fd42:99::2/128" : "10.99.0.2/32",
        history: [1200, 1840, 2650, 3210, 4170, 5832, 4760, 6400, 5220, 5832],
      }
    : stats;
  const elapsed = displayStats.since
    ? Math.floor((Date.now() - displayStats.since) / 1000)
    : null;
  // last_handshake_sec is an ABSOLUTE unix second, not an age — trayview.ts documents the same trap.
  const handshakeAge =
    displayStats.handshakeSec && displayStats.handshakeSec > 0
      ? Math.max(0, Math.floor(Date.now() / 1000) - displayStats.handshakeSec)
      : null;
  const visibleStats: Array<{ label: string; value: string }> = [
    { label: "Bytes in", value: displayStats.rx === null ? "—" : formatBytes(displayStats.rx) },
    { label: "Bytes out", value: displayStats.tx === null ? "—" : formatBytes(displayStats.tx) },
    { label: "Duration", value: elapsed === null ? "—" : formatDuration(elapsed) },
    { label: "Last handshake", value: handshakeAge === null ? "—" : `${handshakeAge}s ago` },
    { label: "Tunnel IP", value: displayStats.address ?? "—" },
  ];
  /**
   * ⛔ THE VERB HAD NO HANDLER AT ALL — the button rendered and did nothing.
   *
   * Two paths, and they are genuinely different rather than one faked:
   *
   *  · IN ELECTRON the bridge exists, so this calls the real `tunnel.up` / `tunnel.down`. The
   *    renderer holds no secret and no config — main resolves the WG config and forwards it to the
   *    privileged helper; we only ever see status back.
   *  · IN A BROWSER there is no bridge and there never will be. Rather than a dead button, the
   *    surface drives its OWN state so the transitions and the hyperdrive are reviewable — and
   *    says on screen that it is doing so. A simulated transition presented as a real one would be
   *    the render-floor violation this epic keeps catching.
   */
  const simulated = desktop() === null;

  async function onAction() {
    const d = desktop();
    if (d && managedConnectBlocked) {
      setProblem(FOREIGN_ENROLLMENT_MESSAGE);
      return;
    }
    if (d) {
      // ⛔ EVERY BRIDGE CALL IS AWAITED INSIDE A try. Before this, a rejected `tunnel.up` became an
      // unhandled rejection in main's log and the window did not move — the user pressed a button
      // and the product said nothing. A verb that can fail must be able to SAY it failed.
      setProblem(null);
      setBusy(true);
      const attemptedLogin = state === "signed_out" || state === "expired_creds";
      try {
        if (attemptedLogin) {
          await d.auth.login();
          await refreshAuth();
          await loadManagedOrganizations();
        } else if (state === "connected" || state === "connecting" || state === "posture_warning" || state === "kill_switch") {
          await d.tunnel.down();
        } else {
          await d.tunnel.up(fullTunnel);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The one error we can turn into a STATE rather than a sentence: main throws this exact
        // string when no credential is stored, which is precisely `signed_out`.
        if (msg.includes("not_authenticated")) {
          setLive("signed_out");
          setAuthed(false);
          setProblem(null);
        } else {
          await reconcileTunnelStateAfterFailure();
          // Login can fail after main has truthfully published Down. Session
          // truth remains the higher-order state: re-read it last so a cancel
          // cannot turn Not signed in / Session expired into a dead Connect.
          if (attemptedLogin) await refreshAuth();
          showProblem(msg);
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    // Browser: drive the local state so the animation can be judged.
    if (state === "connected" || state === "posture_warning" || state === "kill_switch") {
      setLive("disconnected");
      return;
    }
    if (state === "expired_creds") return; // the browser flow has nothing to open here
    setLive("connecting");
    window.setTimeout(() => setLive("connected"), 2200);
  }

  /**
   * ⛔ CHANGE SERVER — THE LAST CAPABILITY THE STEP-3 FLIP STRANDED.
   *
   * `config.setServerUrl` has been on the preload allowlist since S6.2, and after the client stopped
   * loading the web dashboard NOTHING CALLED IT. Pointing the app at a different control plane meant
   * deleting `~/Library/Application Support/@tunnex/client` by hand — an app with a documented verb
   * and no way to reach it, which is the S14.12 class exactly.
   *
   * ⚠ THE SERVER CHANGE REVOKES THE CREDENTIAL, AND THE UI MUST SAY SO BEFORE IT HAPPENS. Main
   * stops the monitors, tears the tunnel down and clears the credential BEFORE persisting the new
   * URL, so there is no window where a new origin holds an old bearer. `reloginRequired` is that
   * fact coming back — it is not advice, it has already happened.
   */
  const [editingServer, setEditingServer] = useState(false);
  const [draftServer, setDraftServer] = useState("");
  const [logText, setLogText] = useState<string>("");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [releaseCheck, setReleaseCheck] = useState<ReleaseCheck | null>(null);
  const [checkingRelease, setCheckingRelease] = useState(false);
  const [importedProfiles, setImportedProfiles] = useState<ImportedProfile[]>([]);
  const [managedOrganizationView, setManagedOrganizationView] = useState<
    ManagedOrganizationEnvelope | null
  >(null);
  const managedOrganizations = managedOrganizationView?.organizations ?? null;
  const enrollmentLocked = managedOrganizationView?.enrollmentLocked === true;
  const enrollmentRecoveryRequired =
    managedOrganizationView?.enrollmentRecoveryRequired === true;
  const enrollmentBlockedByOtherUser =
    managedOrganizationView?.enrollmentBlockedByOtherUser === true;
  const managedConnectBlocked = enrollmentBlockedByOtherUser
    && !importedProfiles.some((profile) => profile.active)
    && view.action === "Connect";
  const [managedOrganizationsFailed, setManagedOrganizationsFailed] =
    useState(false);
  const [organizationNotice, setOrganizationNotice] = useState<string | null>(
    null,
  );
  const [exported, setExported] = useState<string | null>(null);

  /**
   * ⛔ THREE PANES, BECAUSE THE MAIN SCREEN WAS GROWING BY ONE SECTION PER REQUEST.
   *
   * Routing mode, then a server form, then a footer of buttons — each defensible alone, and together
   * a column you scroll to find anything in. A VPN client's home screen answers one question ("am I
   * connected, and what do I press") and everything else is somewhere you go on purpose.
   *
   * > **A SURFACE THAT ONLY EVER GAINS SECTIONS IS NOT A DESIGN, IT IS AN ACCUMULATION.** The fix is
   * > not smaller sections; it is a second place to put them.
   */
  const [pane, setPane] = useState<
    "home" | "beam" | "profiles" | "settings" | "logs" | "help"
  >("home");
  useEffect(()=>desktop()?.beam?.onShow?.(()=>setPane("beam")),[]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function loadLog() {
    const d = desktop();
    if (!d) return;
    setLogText(await d.diag.readLog());
  }

  async function loadManagedOrganizations(): Promise<void> {
    const d = desktop();
    if (!d) return;
    setManagedOrganizationsFailed(false);
    setManagedOrganizationView(null);
    try {
      setManagedOrganizationView(await d.tunnel.managedOrganizations());
    } catch (error) {
      console.error("Could not load managed organizations", error);
      setManagedOrganizationsFailed(true);
    }
  }

  async function onSelectManagedOrganization(
    organization: ManagedOrganization,
  ): Promise<void> {
    const d = desktop();
    if (!d || organization.selected || enrollmentLocked) return;
    setProblem(null);
    setBusy(true);
    try {
      const view = await d.tunnel.selectManagedOrganization(
        organization.id,
      );
      setManagedOrganizationView(view);
      setManagedOrganizationsFailed(false);
      setOrganizationNotice(null);
    } catch (error) {
      showProblem(error);
    } finally {
      setBusy(false);
    }
  }

  async function onExportLog() {
    const d = desktop();
    if (!d) return;
    try {
      const path = await d.diag.exportLog();
      // null is a CANCELLED dialog, not a failure — saying "exported" there would be the UI
      // claiming an action it did not perform.
      setExported(path);
    } catch (e) {
      showProblem(e);
    }
  }

  async function checkRelease(): Promise<void> {
    const d = desktop();
    if (!d || checkingRelease) return;
    setCheckingRelease(true);
    try {
      setReleaseCheck(await d.diag.checkRelease());
    } finally {
      setCheckingRelease(false);
    }
  }

  async function openReleaseDownload(): Promise<void> {
    const d = desktop();
    if (!d) return;
    await d.diag.openReleaseDownload();
  }

  useEffect(() => {
    if (pane === "logs") void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  async function refreshImportedProfilesAfterFailure(): Promise<void> {
    const d = desktop();
    if (!d) return;
    try {
      setImportedProfiles(await d.tunnel.importedProfiles());
    } catch (error) {
      // Preserve the action's primary error. A failed recovery read is useful in
      // logs but cannot justify inventing a profile selection in the renderer.
      console.error("Could not refresh imported profiles after action failure", error);
    }
  }

  async function onImportConfig() {
    const d = desktop();
    if (!d) return;
    setProblem(null);
    setBusy(true);
    try {
      const p = await d.tunnel.importConfig();
      // null = the picker was cancelled. Not an error, and not an import.
      if (p) {
        const profiles = await d.tunnel.importedProfiles();
        setImportedProfiles(profiles);
        const active = profiles.find((profile) => profile.active);
        if (active) setFullTunnel(active.fullTunnel);
      }
    } catch (e) {
      // parseWgConf is strict on purpose: a half-parsed profile would be handed to a ROOT helper.
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function onSelectImported(profile: ImportedProfile) {
    const d = desktop();
    if (!d || profile.active) return;
    setProblem(null);
    setBusy(true);
    try {
      const profiles = await d.tunnel.selectImportedProfile(profile.id);
      setImportedProfiles(profiles);
      setFullTunnel(profile.fullTunnel);
      setLive("disconnected");
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      await refreshImportedProfilesAfterFailure();
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  /** Switch connection source, never delete the imported file just to reach sign-in. */
  async function onUseManagedProfile() {
    const d = desktop();
    if (!d) return;
    setProblem(null);
    setBusy(true);
    try {
      const profiles = await d.tunnel.useManagedProfile();
      setImportedProfiles(profiles);
      setPane("home");
      const ok = await refreshAuth();
      if (ok) applyTunnelStatus(await d.tunnel.status());
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      await refreshImportedProfilesAfterFailure();
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function onForgetImported(id: string) {
    const d = desktop();
    if (!d) return;
    setProblem(null);
    setBusy(true);
    try {
      const profiles = await d.tunnel.forgetImported(id);
      setImportedProfiles(profiles);
      await refreshAuth();
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      await refreshImportedProfilesAfterFailure();
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function onChangeServer() {
    const d = desktop();
    if (!d) return;
    setProblem(null);
    setBusy(true);
    try {
      const res = await d.config.setServerUrl(draftServer.trim());
      setServerUrl(res.url);
      setEditingServer(false);
      // The credential was cleared server-side of this call; re-read rather than assume.
      await refreshAuth();
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      await refreshServerUrlAfterFailure();
      await refreshImportedProfilesAfterFailure();
      // A failed server switch may have cleared or retained the credential;
      // only the keychain read may decide. Apply it last so auth wins over Down.
      await refreshAuth();
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  /** Sign out ends the session; the managed device stays enrolled for this installation. */
  async function onSignOut() {
    const d = desktop();
    if (!d) return;
    setProblem(null);
    setBusy(true);
    try {
      await d.auth.logout();
      await refreshAuth();
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      // Auth truth still wins over tunnel truth. In the expected failure paths
      // the credential remains, but re-read instead of assuming that outcome.
      await refreshAuth();
      showProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveDevice() {
    const d = desktop();
    const question = enrollmentRecoveryRequired
      ? "Abandon this unfinished enrollment and enroll again? Any same-owner active or pending device will be revoked first."
      : "Remove this device? It will be revoked and a future connection must enroll again.";
    if (!d || !window.confirm(question)) return;
    setProblem(null);
    setBusy(true);
    try {
      const removed = await d.auth.removeDevice();
      if (!removed) {
        setProblem("No enrolled managed device was found. Nothing was removed.");
        return;
      }
      setLive("disconnected");
      setOrganizationNotice(
        enrollmentRecoveryRequired
          ? "Unfinished enrollment cleared. The next connection will create a new device key."
          : "Device removed. Choose an organization for the next enrollment.",
      );
      await loadManagedOrganizations();
    } catch (e) {
      await reconcileTunnelStateAfterFailure();
      showProblem(
        e,
        isForeignEnrollmentError(e) ? FOREIGN_ENROLLMENT_MESSAGE : REMOVE_DEVICE_RETRY_MESSAGE,
      );
    } finally {
      setBusy(false);
    }
  }

  const hyperRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<HTMLCanvasElement | null>(null);
  const hyperState = useRef(createHyperState());
  const mode: HyperMode =
    state === "connected" || state === "posture_warning"
      ? "connected"
      : state === "connecting"
        ? "connecting"
        : "idle";

  useEffect(() => {
    hyperState.current.mode = mode;
  }, [mode]);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const fit = (cv: HTMLCanvasElement) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return null;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    };
    const frame = () => {
      const animated = hyperState.current;
      stepLink(animated);
      const background = hyperRef.current && fit(hyperRef.current);
      if (background) drawHyper(background.ctx, background.w, background.h, animated, Date.now());
      const graph = graphRef.current && fit(graphRef.current);
      if (graph) drawGraph(graph.ctx, graph.w, graph.h, historyRef.current);
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  const historyRef = useRef<number[]>([]);
  useEffect(() => {
    historyRef.current = displayStats.history;
  }, [displayStats.history]);

  return (
    // The native window owns the frame; only its selected pane scrolls.
    <div className="client-workspace relative flex h-dvh flex-col overflow-hidden bg-bg text-ink-body">
      {/* ── TITLE ─────────────────────────────────────────────────────────────────────────── */}
      {/* ⛔ CLEARS THE TRAFFIC LIGHTS, AND IS THE DRAG HANDLE. With `titleBarStyle: hiddenInset` the
          page paints under the window buttons, so content at the top-left would sit BEHIND them —
          the wordmark was going to end up with three coloured circles on it. `pt-8` is the inset
          macOS reserves.

          ⚠ AND THE WINDOW MUST STILL BE DRAGGABLE. A hidden title bar removes the strip people grab,
          so this header declares itself the drag region — with the interactive children opting back
          OUT, since a button inside a drag region swallows the click. */}
      <div
        className="client-titlebar flex items-center gap-2 px-3 pt-7"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        {/* ⛔ THE REAL MARK, via the shared Logo — the previous version drew a bare <img> at 22px
            and lost the wordmark entirely. Logo derives both dimensions from the asset ratios, so
            it cannot be squashed the way a hand-sized img was. */}
        {/* ⛔ THE MARK IS THE IDENTITY AND IT WAS BEING TRIMMED. It rendered at 22px inside a
            `rounded-lg` crop, so the shape lost its corners at the one size where it can least
            afford to. Bigger, uncropped, and paired with the WORDMARK rather than a mono caption —
            the brand kit draws the name; retyping it in a monospace font was a different logo. */}
        {/* ⛔ THE WORDMARK, NOT THE MARK — AND THE REASON IS IN THE ASSET, NOT IN THE CSS.
            `tunnex-logo.svg` bakes in `<rect width="577" height="551" fill="#0A0A0A">` and its
            glyph runs corner to corner, so at any size it renders as a dark plated tile with zero
            breathing room. Removing `rounded-lg` stopped US cropping it; nothing in CSS can give
            artwork padding it does not have.

            This is the same brand block the web shell uses for its home affordance (wordmark +
            tagline), so the two surfaces now show the identity the same way instead of one of them
            showing a tile. The mark returns here the day the asset ships with a margin. */}
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="client-navigation-toggle flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-white/[.11] hover:text-ink-heading"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <Icon name="menu" size={18} />
        </button>
        <span className="flex flex-col justify-center">
          <Logo size={24} wordmarkOnly />
          <Tagline className="mt-0.5" />
        </span>
        {/* The tray appearance is shown in-window too, so a reviewer can see what the icon WOULD
            be without needing the tray — which is the part no instrument of ours can verify. */}
        {/* ⛔ THE RAW APPEARANCE NAME IS GONE. It printed "grey" / "solid" next to the dot —
            internal vocabulary for how the TRAY ICON is drawn, shown to a user who has no reason to
            know the tray has appearances, three lines above a status word that already says
            "Connected". A debug readout that survived into the product.

            The dot stays: it is the one thing in the window that mirrors what the menu-bar icon
            looks like right now. It carries the state in its LABEL, for a screen reader and on
            hover, rather than in a word beside it. */}
        <div className="ml-auto flex items-center gap-2">
        {simulated && <span className="client-preview-indicator" title="Browser preview: connection controls and preview traffic are simulated.">Preview</span>}
        {!preview && <BeamReviewNotifications includeReviews={authed === true} />}
        <span
          data-tray={tray}
          className="flex items-center gap-1.5"
          title={view.label}
          aria-label={`Status: ${view.label}`}
        >
          <span
            className={
              "h-2 w-2 rounded-full " +
              (tray === "solid"
                ? "bg-accent-400"
                : tray === "pulsing"
                  ? "animate-pulse bg-warn"
                : tray === "warning"
                  ? "bg-warn"
                  : tray === "red"
                    ? "bg-danger"
                    : "bg-slate-600")
            }
          />
        </span>
        </div>
      </div>

      {/* OpenVPN-style drawer: Home stays one focused control surface; secondary
          functions are available on purpose without permanently consuming height. */}
      {drawerOpen && (
        <div className="absolute inset-0 z-20 overflow-hidden" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <aside className="client-navigation-drawer absolute inset-y-0 left-0 flex w-[calc(100%_-_64px)] max-w-[280px] flex-col border-r border-line bg-[#151515] px-3 pb-4 pt-9 shadow-2xl">
            <div className="mb-4 flex items-center justify-between px-2">
              <span className="flex flex-col justify-center">
                <Logo size={20} wordmarkOnly />
                <Tagline className="mt-0.5 scale-[.8] origin-left" />
              </span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded text-lg text-ink-secondary hover:bg-white/[.08] hover:text-ink-heading"
              >
                ×
              </button>
            </div>
            <nav aria-label="Client navigation" className="client-navigation flex flex-col gap-1">
              {(
                [
                  ["home", "Home"],
                  ["beam", "Local Sharing"],
                  ["profiles", "Profiles"],
                  ["settings", "Settings"],
                  ["logs", "Logs"],
                  ["help", "Help"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  data-pane={key}
                  aria-current={pane === key ? "page" : undefined}
                  onClick={() => {
                    setPane(key);
                    setDrawerOpen(false);
                  }}
                  className={
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors " +
                    (pane === key
                      ? "bg-white/[.10] text-ink-heading"
                      : "text-ink-secondary hover:bg-white/[.06] hover:text-ink-body")
                  }
                >
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <p className="client-drawer-version mt-auto pt-3 text-xs text-ink-secondary" data-drawer-version>
              Tunnex {appInfo ? `v${appInfo.version}` : ""}
            </p>
          </aside>
        </div>
      )}
      <main className="client-main flex min-h-0 flex-1 flex-col overflow-y-auto">
        {authed === true && enrollmentBlockedByOtherUser && (
          <div className="client-notice client-notice-warning text-warn">
            <p role="status">{FOREIGN_ENROLLMENT_MESSAGE}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSignOut()}
              className="client-button mt-2 text-warn"
            >
              Sign out to recover enrollment
            </button>
          </div>
        )}
        {problem && (
          <p
            role="alert"
            className="client-notice client-notice-danger text-danger"
          >
            {problem}
          </p>
        )}

        {pane === "beam" && <BeamPanel />}
        {pane === "home" && (
          <div className="client-home">
            {/* ── STATUS HEAD ─────────────────────────────────────────────────────────────────── */}
            <section className="client-home-status">
              <h1
                data-state={state}
                className={
                  "client-connection-state text-[26px] font-semibold leading-tight " +
                  (view.severity === "loud"
                    ? "text-danger"
                    : view.severity === "ok"
                      ? "text-accent-400"
                      : view.severity === "warn"
                        ? "text-warn"
                        : "text-ink-heading")
                }
              >
                {view.label}
              </h1>
              {state !== "connected" && (
                <p className="mt-1 text-sm text-ink-secondary" data-status-detail>{view.detail}</p>
              )}
              {state === "connected" && displayStats.connectionPath && (
                <p className="mt-1 text-sm text-ink-secondary" data-connection-path>
                  Connection: {displayStats.connectionPath}
                </p>
              )}
              {postureReason && (state === "posture_warning" || state === "posture_blocked") && (
                <p className="mt-2 text-sm text-warn" data-posture-reason>{postureReason}</p>
              )}
            </section>

            <div className="client-connection-visual relative" data-animation-control>
              <canvas
                ref={hyperRef}
                id="tnxHyper"
                aria-hidden
                className="absolute inset-0 block h-full w-full"
              />
              {/* The mesh is the primary connection affordance. The explicit, labelled centre
                  control makes click → linking peers → live mesh visible without a duplicate
                  action button at the bottom of the surface. */}
              {view.action ? (
                <button
                  type="button"
                  data-action
                  aria-label={view.action}
                  title={view.action}
                  onClick={() => {
                    setShowActionHint(false);
                    void onAction();
                  }}
                  disabled={busy || managedConnectBlocked}
                  className={
                    "tnx-connect-control absolute left-1/2 top-1/2 z-10 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-400 disabled:cursor-wait disabled:opacity-60 " +
                    (view.severity === "loud"
                      ? "tnx-connect-control-danger"
                      : view.action === "Disconnect"
                        ? "tnx-connect-control-live"
                        : "")
                  }
                >
                  <span className="tnx-connect-ripple" aria-hidden />
                  <span className="tnx-connect-ripple tnx-connect-ripple-late" aria-hidden />
                  <span className="tnx-connect-orbit" aria-hidden>
                    <span className="tnx-connect-orbit-segment tnx-connect-orbit-a" />
                    <span className="tnx-connect-orbit-segment tnx-connect-orbit-b" />
                    <span className="tnx-connect-orbit-segment tnx-connect-orbit-c" />
                  </span>
                  <span
                    className={"tnx-connect-orb " + (view.action === "Disconnect" ? "tnx-connect-orb-live" : "tnx-connect-orb-idle")}
                    aria-hidden
                  />
                  <span className={"client-connect-label " + (showActionHint ? "client-connect-label-hint" : "")} aria-hidden>{view.action}</span>
                </button>
              ) : null}
            </div>
            <section className="client-section client-connection-metrics" data-connection-metrics>
              <div className="client-section-header flex items-baseline justify-between">
                <span className="client-section-title text-ink-secondary">
                  Connection stats
                </span>
                <span className="client-connection-rate text-ink-heading tabular-nums">
                  {displayStats.rate === null ? "—" : formatRate(displayStats.rate)}
                </span>
              </div>
              <canvas ref={graphRef} id="tnxGraph" aria-hidden className="mt-2 block h-10 w-full" />
              <div
                className="client-rate-summary mt-1 flex min-h-4 justify-between text-xs text-ink-secondary"
                data-connection-rate-summary
              >
                {displayStats.rate !== null && (
                  <>
                    <span>{formatRate(displayStats.peak)} peak</span>
                    <span>{formatRate(displayStats.rate)}</span>
                  </>
                )}
              </div>
              <dl className="client-facts" data-connection-stat-rows>
                {visibleStats.map(({ label, value }) => (
                  <div key={label} className={label === "Tunnel IP" ? "client-fact-wide" : ""}>
                    <dt data-stat-label>
                      {label}
                    </dt>
                    <dd
                      className="tabular-nums"
                      title={value}
                      data-stat-value
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

          </div>
        )}

        {(pane === "settings" || pane === "profiles") && (
          <>
            <h1 className="client-pane-title">{pane === "settings" ? "Settings" : "Profiles"}</h1>
            {/* ── ROUTING MODE ────────────────────────────────────────────────────────────────────
            ⛔ THE CONTROL SAID THE OPPOSITE OF WHAT IT DID, AND THE SAFE-LOOKING SETTING WAS THE
            LEAKING ONE.

            It was a checkbox LABELLED "Split tunnel" and BOUND to `fullTunnel`. So:

              unchecked -> reads as "split tunnel is off" -> user believes ALL traffic is protected
                        -> actually fullTunnel === false -> SPLIT: most traffic bypasses the tunnel

            > **A USER WHO BELIEVES THEY ARE FULLY TUNNELLED AND IS NOT HAS A WORSE PROBLEM THAN ONE
            > WHO KNOWS THEY ARE SPLIT.** The inverted label pointed the error at the dangerous side,
            > and a checkbox cannot say which state is which — the unchecked box has no words on it.

            Two named options now, each stating what it DOES to traffic. No inference from a tick. */}
            {pane === "settings" && <fieldset className="client-section">
              <legend className="client-section-title">
                Routing
              </legend>
              {(
                [
                  [
                    "full",
                    "All traffic",
                    "Send all traffic through Tunnex.",
                  ],
                  [
                    "split",
                    "Only Tunnex routes",
                    "Only routes published by your admin use Tunnex.",
                  ],
                ] as const
              ).map(([key, label, why]) => (
                <label
                  key={key}
                  className="mt-1 flex cursor-pointer items-start gap-2.5 text-sm text-ink-body"
                >
                  <input
                    type="radio"
                    name="routing"
                    className="mt-1"
                    checked={key === "full" ? fullTunnel : !fullTunnel}
                    onChange={() => setFullTunnel(key === "full")}
                  />
                  <span>
                    {label}
                    <span className="block text-xs text-ink-secondary">
                      {why}
                    </span>
                  </span>
                </label>
              ))}
              {/* Changing this re-mints the device config (deviceconfig.ts) — it is not a live switch. */}
              <p className="mt-2 text-[11px] text-ink-secondary">
                Changing this while connected refreshes the device configuration.
              </p>
            </fieldset>}

            {/* ⛔ THE FAILURE SENTENCE. `not_authenticated` became a STATE above; anything else is shown
            verbatim rather than swallowed. A raw message is worse than a written one and far better
            than silence — and it names the verb that produced it. */}
            {/* ── PROFILE ─────────────────────────────────────────────────────────────────────
                ⛔ FOUNDER-RULED AFTER I ARGUED AGAINST IT, AND THE OBJECTION IS BUILT IN RATHER
                THAN DROPPED. A `.conf` downloaded at device creation now connects. What it cannot
                do is carry a device identity, so the monitors that keep a tunnel honest have
                nothing to poll — which is stated here and on the connection screen instead of
                being left in a design note. */}
            {pane === "profiles" && <div className="client-pane-stack">
              {(() => {
                const activeProfile = importedProfiles.find((profile) => profile.active);
                return (
                  <section className="client-section" data-connection-source>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-medium text-ink-heading">Tunnex account</h2>
                        <p className="mt-0.5 text-[11px] text-ink-secondary">
                          {activeProfile
                            ? "Switch to your enrolled device or sign in. Imported files stay saved."
                            : "Use your enrolled device or sign in to Tunnex."}
                        </p>
                      </div>
                      {activeProfile ? (
                        <button
                          type="button"
                          data-usemanagedprofile
                          disabled={busy}
                          onClick={() => void onUseManagedProfile()}
                          className="client-button shrink-0"
                        >
                          Use account
                        </button>
                      ) : (
                        <span className="shrink-0 text-[10px] text-accent-400">Selected</span>
                      )}
                    </div>
                  </section>
                );
              })()}
              {!simulated && (
                <section
                  className="client-section"
                  aria-labelledby="managed-organizations-heading"
                  data-managed-organizations
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2
                        id="managed-organizations-heading"
                        className="text-sm font-medium text-ink-heading"
                      >
                        Organizations
                      </h2>
                      <p className="mt-0.5 text-[11px] text-ink-secondary">
                        Choose where a new managed device is enrolled.
                      </p>
                    </div>
                    {enrollmentLocked && (
                      <button
                        type="button"
                        disabled={busy || enrollmentBlockedByOtherUser}
                        onClick={() => void onRemoveDevice()}
                        className="client-button shrink-0 text-warn"
                      >
                        {enrollmentRecoveryRequired ? "Abandon and re-enroll" : "Remove device"}
                      </button>
                    )}
                  </div>
                  {organizationNotice && (
                    <p
                      className="client-notice client-notice-warning mt-3 text-warn"
                      role="status"
                    >
                      {organizationNotice}
                    </p>
                  )}
                  {managedOrganizationsFailed ? (
                    <div className="mt-3">
                      <p className="text-xs text-warn">
                        Organizations could not be loaded. Sign in, then try again.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void loadManagedOrganizations()}
                        className="client-button mt-2"
                      >
                        Retry
                      </button>
                    </div>
                  ) : managedOrganizations === null ? (
                    <p className="mt-3 text-xs text-ink-secondary">
                      Loading organizations…
                    </p>
                  ) : managedOrganizations.length === 0 ? (
                    <p className="mt-3 text-xs text-warn">
                      No organizations are available for this account. Ask an administrator to add you to one.
                    </p>
                  ) : managedOrganizations.length === 1 ? (
                    <div className="client-record mt-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="client-record-title text-ink-heading">
                            {managedOrganizations[0].name}
                          </p>
                          <p className="client-record-detail text-ink-secondary">
                            {managedOrganizations[0].slug}
                          </p>
                        </div>
                        <span className="shrink-0 text-[10px] text-accent-400">
                          {enrollmentLocked
                            ? managedOrganizations[0].selected
                              ? "Enrolled device"
                              : "Remove device first"
                            : "Only organization"}
                        </span>
                      </div>
                      {!enrollmentLocked && (
                        <p className="mt-2 text-[11px] text-ink-secondary">
                          This organization will be used automatically. No selection is needed.
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      {enrollmentLocked && (
                        <p className="mt-3 text-[11px] text-warn">
                          This device stays with its enrolled organization. Remove device before choosing another organization.
                        </p>
                      )}
                      <ul className="client-record-list" aria-label="Managed organizations">
                        {managedOrganizations.map((organization) => {
                          return (
                            <li
                              key={organization.id}
                              className={
                                "client-record " + (organization.selected ? "is-selected" : "")
                              }
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="client-record-title text-ink-heading">
                                    {organization.name}
                                  </p>
                                  <p className="client-record-detail text-ink-secondary">
                                    {organization.slug}
                                  </p>
                                </div>
                                {organization.selected ? (
                                  <span className="shrink-0 text-[10px] text-accent-400">
                                    {enrollmentLocked ? "Enrolled device" : "Selected"}
                                  </span>
                                ) : enrollmentLocked ? (
                                  <span className="shrink-0 text-[10px] text-ink-secondary">
                                    Remove device first
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy || enrollmentBlockedByOtherUser}
                                    onClick={() => void onSelectManagedOrganization(organization)}
                                    aria-label={`Use ${organization.name}`}
                                    className="client-button shrink-0"
                                  >
                                    Use
                                  </button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </section>
              )}
              <section className="client-section">
                <div className="client-section-header flex items-center justify-between gap-3">
                  <h2 className="client-section-title">
                    Imported profiles
                  </h2>
                  <button
                    type="button"
                    data-importconfig
                    disabled={busy}
                    onClick={() => void onImportConfig()}
                    className="client-button"
                  >
                    Import .conf
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-ink-secondary">
                  Keep separate WireGuard files for different devices or gateways. Switching disconnects the current tunnel; imported profiles do not report posture or monitor revocation in this app.
                </p>
                {importedProfiles.length === 0 ? (
                  <p className="client-empty">No imported profiles yet.</p>
                ) : (
                  <ul className="client-record-list" aria-label="Imported profiles">
                    {importedProfiles.map((profile) => (
                      <li key={profile.id} className={"client-record " + (profile.active ? "is-selected" : "")}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="client-record-title text-ink-heading">{profile.name}</p>
                            <p className="client-record-detail text-ink-secondary">{profile.endpoint || "Gateway not specified"}</p>
                            <p className="client-record-detail text-ink-secondary">{profile.address || "No tunnel IP"} · {profile.fullTunnel ? "all traffic" : "Tunnex routes"}</p>
                          </div>
                          {profile.active && <span className="shrink-0 text-[10px] text-accent-400">Selected</span>}
                        </div>
                        <div className="client-actions mt-3">
                          <button type="button" disabled={busy || profile.active} onClick={() => void onSelectImported(profile)} className="client-button">
                            {profile.active ? "Selected" : "Use this profile"}
                          </button>
                          <button type="button" data-forgetimported={profile.id} disabled={busy} onClick={() => void onForgetImported(profile.id)} className="client-button text-warn">
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>}

            {/* ── SERVER ──────────────────────────────────────────────────────────────────── */}
            {pane === "settings" && <section className="client-section">
              <h2 className="client-section-title">
                Server
              </h2>
              <p className="client-server-address mt-2 text-sm text-ink-body">
                {serverUrl ?? "n/a"}
              </p>
              {identity && (
                <p className="client-record-detail text-ink-secondary">
                  device {identity.slice(0, 12)}
                </p>
              )}
              {!simulated && !editingServer && (
                <div className="client-actions mt-3">
                  <button
                    type="button"
                    data-changeserver
                    disabled={busy}
                    onClick={() => {
                      setDraftServer(serverUrl ?? "");
                      setEditingServer(true);
                    }}
                    className="client-button"
                  >
                    Change server
                  </button>
                  {authed === true && (
                    <button
                      type="button"
                      data-signout
                      disabled={busy}
                      onClick={() => void onSignOut()}
                      className="client-button"
                    >
                      Sign out
                    </button>
                  )}
                  {authed === true && (
                    <button
                      type="button"
                      data-removedevice
                      disabled={busy || enrollmentBlockedByOtherUser}
                      onClick={() => void onRemoveDevice()}
                      className="client-button text-warn"
                    >
                      {enrollmentRecoveryRequired ? "Abandon and re-enroll" : "Remove device"}
                    </button>
                  )}
                </div>
              )}
              {editingServer && !simulated && (
                <form
                  className="client-section-body"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void onChangeServer();
                  }}
                >
                  <label
                    className="block text-xs text-ink-secondary"
                    htmlFor="tnx-server"
                  >
                    Control-plane URL
                  </label>
                  <input
                    id="tnx-server"
                    type="url"
                    autoComplete="off"
                    value={draftServer}
                    onChange={(e) => setDraftServer(e.target.value)}
                    placeholder="https://vpn.example.com"
                    className="client-field mt-2"
                  />
                  {/* ⛔ SAID BEFORE THE BUTTON IS PRESSED, NOT AFTER. Changing origin revokes the stored
                  credential — the user must know that is the cost, not discover it. */}
                  <p className="mt-2 text-[11px] text-warn">
                    Switching servers signs you out and tears down the tunnel. A
                    credential is only ever valid for the server it was issued by.
                  </p>
                  <div className="client-actions mt-3">
                    <button
                      type="submit"
                      disabled={busy || draftServer.trim().length === 0}
                      className="client-button-primary"
                    >
                      Switch server
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingServer(false)}
                      className="client-button"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </section>}

            {pane === "settings" && <section className="client-section">
              <h2 className="client-section-title">
                About
              </h2>
              <p className="mt-2 text-sm text-ink-body" data-version>
                Tunnex {appInfo ? `v${appInfo.version}` : "version n/a"}
              </p>
              {appInfo && appInfo.update.kind !== "ready" && (
                <p className="mt-2 text-[11px] text-ink-secondary">
                  <span className="text-warn">{appInfo.update.reason}</span>{" "}
                  Updates are manual in this build. Check Tunnex for a newer version.
                </p>
              )}
              {releaseCheck?.kind === "available" && (
                <p className="mt-2 text-[11px] text-ink-body" data-updateavailable>
                  Version {releaseCheck.version} is available.
                </p>
              )}
              {releaseCheck?.kind === "current" && (
                <p className="mt-2 text-[11px] text-ink-secondary" data-updatecurrent>
                  You have the latest released version.
                </p>
              )}
              {releaseCheck?.kind === "unavailable" && (
                <p className="mt-2 text-[11px] text-warn" data-updateunavailable>{releaseCheck.reason}</p>
              )}
              <div className="client-actions mt-3">
                <button
                  type="button"
                  data-checkupdates
                  disabled={checkingRelease}
                  onClick={() => void checkRelease()}
                  className="client-button"
                >
                  {checkingRelease ? "Checking…" : "Check for updates"}
                </button>
              {releaseCheck?.kind === "available" && (
                <button
                  type="button"
                  data-downloadupdate
                  onClick={() => void openReleaseDownload()}
                  className="client-button"
                >
                  Download v{releaseCheck.version}
                </button>
              )}
              </div>
            </section>}

          </>
        )}

        {pane === "logs" && (
          <section className="client-logs flex min-h-0 flex-1 flex-col">
            <h1 className="client-pane-title">Logs</h1>
            <div className="client-section-header flex items-center gap-2">
              <h2 className="client-section-title">
                Client log
              </h2>
              <button
                type="button"
                data-refreshlogs
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void loadLog()}
                className="client-button ml-auto"
              >
                <Icon name="refresh-cw" size={16} />
              </button>
              <button
                type="button"
                data-exportlogs
                onClick={() => void onExportLog()}
                className="client-button"
              >
                Export
              </button>
              <button
                type="button"
                data-openlogs
                onClick={() => void desktop()?.diag.openLogs()}
                className="client-button"
              >
                Reveal
              </button>
            </div>
            {exported && (
              <p className="mt-2 text-[11px] text-ink-secondary">
                Saved to {exported}
              </p>
            )}
            {/* ⛔ NEWEST LAST, AND SCROLLED HERE RATHER THAN ON THE PAGE. The log is the one thing
                in this app that is legitimately long; giving it its own scroll box is what keeps
                the window itself from becoming scrollable. */}
            <pre
              data-logview
              className="client-log-output min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink-secondary"
            >
              {logText || "The log is empty."}
            </pre>
          </section>
        )}

        {pane === "help" && (
          <div className="client-pane-stack">
            <h1 className="client-pane-title">Help</h1>
          <section className="client-section">
            <p className="mt-2 text-sm text-ink-body">
              Check the client log before contacting your administrator.
            </p>
            <p className="mt-1 text-xs text-ink-secondary">
              This build has no embedded help site. The Logs pane lets you refresh, export, or reveal the client log.
            </p>
            <button
              type="button"
              onClick={() => setPane("logs")}
              className="client-button mt-3"
            >
              Open logs
            </button>
          </section>
          </div>
        )}
      </main>
    </div>
  );
}

/** Map the bridge's status to our state union. Kept tiny and total. */
export function connectionPathLabel(path: unknown): string {
  if (path === "relay") return "Relay";
  if (path === "direct") return "Direct";
  if (path === "negotiating") return "Negotiating";
  return "Path unavailable";
}

export function mapStatus(s: { state?: string; last_handshake_sec?: number } | null | undefined): ClientState {
  switch (s?.state) {
    case "up":
      return s.last_handshake_sec && Number.isFinite(s.last_handshake_sec)
        && s.last_handshake_sec > 0
        && Math.max(0, Date.now() / 1000 - s.last_handshake_sec) <= 180
        ? "connected" : "connecting";
    case "connecting":
      return "connecting";
    case "revoked":
      return "revoked";
    case "pending_approval":
      return "pending_approval";
    case "migrate_failed":
      return "migrate_failed";
    case "posture_warning":
      return "posture_warning";
    case "posture_blocked":
      return "posture_blocked";
    case "failed":
      return "failed";
    default:
      return "disconnected";
  }
}

/** Product copy for renderer-visible failures. Raw IPC and HTTP details stay in logs. */
function isForeignEnrollmentError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("managed_enrollment_owner_mismatch");
}

export function clientErrorMessage(error: unknown): string {
  if (isForeignEnrollmentError(error)) return FOREIGN_ENROLLMENT_MESSAGE;
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("revoke_device_failed")) {
    return REMOVE_DEVICE_RETRY_MESSAGE;
  }
  if (raw.includes("not_authenticated")) {
    return "Sign in again, then try this action.";
  }
  return "That action did not complete. Try again or check Logs.";
}
