import type { BeamSharedView, BeamAction, BeamCreate, BeamTarget, BeamView, BeamShare, BeamGrantsPreview, BeamGrantsImpact, BeamInventory } from "./beamtypes";
// Desktop bridge access (S6.2). The Electron preload exposes a verb-specific
// allowlist as window.tunnex (auth.*/config.*/reserved tunnel.*). Its PRESENCE
// is the desktop signal — one SPA bundle, runtime branch. In the browser
// window.tunnex is undefined and every helper here returns null / false.

export interface AuthStatus {
  loggedIn: boolean;
  expired?: boolean;
  fingerprint?: string;
  expiresAt?: string;
  secureStorage: boolean;
}

/** Mirrors the preload's AppInfo. `update` is a build-time verdict, not a network result. */
export interface AppInfo {
  version: string;
  update:
    | { kind: "disabled"; reason: string; detail: string }
    | { kind: "no_feed"; reason: string; detail: string }
    | { kind: "ready" };
}

export type ReleaseCheck =
  | { kind: "available"; version: string }
  | { kind: "current"; version: string }
  | { kind: "unavailable"; reason: string };

/** An imported `.conf` profile, as main reports it — never key material. */
export interface ImportedProfile {
  id: string;
  name: string;
  address?: string;
  endpoint?: string;
  fullTunnel: boolean;
  active: boolean;
}

/** A managed account choice reported by main. Never contains a bearer or tunnel config. */
export interface ManagedOrganization {
  id: string;
  name: string;
  slug: string;
  selected: boolean;
}

export interface ManagedOrganizationEnvelope {
  organizations: ManagedOrganization[];
  enrollmentLocked: boolean;
  enrollmentRecoveryRequired?: boolean;
  enrollmentBlockedByOtherUser?: boolean;
}

export interface TunnexBridge {
  notices?: {
    list():Promise<ClientNotice[]>;
    markRead(id:string):Promise<void>;
    onChanged(cb:()=>void):()=>void;
  };
  beam?: {
    shared?(input?:BeamInventory):Promise<BeamSharedView>; openSharedLink?(id:string):Promise<void>;
    notifications?():Promise<BeamSharedView>;
    previewGrants(input:BeamGrantsPreview):Promise<BeamGrantsImpact>;
    view(input?:BeamInventory):Promise<BeamView>; checkLocal(target:BeamTarget):Promise<{ready:boolean}>; create(input:BeamCreate):Promise<BeamShare>; action(input:BeamAction):Promise<BeamShare>; retry(id:string):Promise<void>; idempotencyKey():Promise<string>; copyLink(id:string):Promise<void>; openLink(id:string):Promise<void>; onChanged(cb:()=>void):()=>void; onShow?(cb:()=>void):()=>void;
  };
  auth: {
    login(): Promise<{ fingerprint: string; expiresAt: string }>;
    logout(): Promise<void>;
    removeDevice(): Promise<boolean>;
    status(): Promise<AuthStatus>;
  };
  // Troubleshooting. `openLogs` reveals the file in the OS file manager — the log is never read
  // into the renderer, so a compromised page cannot read it out.
  diag: {
    logPath(): Promise<string>;
    openLogs(): Promise<void>;
    readLog(): Promise<string>;
    exportLog(): Promise<string | null>;
    appInfo(): Promise<AppInfo>;
    checkRelease(): Promise<ReleaseCheck>;
    openReleaseDownload(): Promise<void>;
  };
  config: {
    getServerUrl(): Promise<string>;
    setServerUrl(
      url: string,
    ): Promise<{ url: string; reloginRequired: boolean }>;
  };
  tunnel: {
    // fullTunnel = the split-tunnel toggle intent (S6.4); effective only when a
    // device is minted (get-or-create reuses an existing config as-is).
    up(fullTunnel?: boolean): Promise<TunnelStatus>;
    down(): Promise<void>;
    status(): Promise<TunnelStatus>;
    onStatusChanged(cb: (s: TunnelStatus) => void): () => void;
    managedOrganizations(): Promise<ManagedOrganizationEnvelope>;
    selectManagedOrganization(id: string): Promise<ManagedOrganizationEnvelope>;
    onOrganizationSelectionRequired(cb: () => void): () => void;
    importConfig(): Promise<ImportedProfile | null>;
    importedInfo(): Promise<ImportedProfile | null>;
    importedProfiles(): Promise<ImportedProfile[]>;
    selectImportedProfile(id: string): Promise<ImportedProfile[]>;
    useManagedProfile(): Promise<ImportedProfile[]>;
    forgetImported(id?: string): Promise<ImportedProfile[]>;
  };
}

export interface ClientNotice {id:string;kind:"access_revoked"|"device_revoked"|"update_available";title:string;body:string;created_at:string;}

// TunnelStatus mirrors the helper plus client-synthesized status (no secrets — never
// key material). Revocation, migration and posture verdicts originate in main.
export interface TunnelStatus {
  connection_path?: "direct" | "relay" | "negotiating" | "unknown";
  state: "down" | "up" | "failed" | "revoked" | "pending_approval" | "migrate_failed" | "posture_warning" | "posture_blocked";
  interface?: string;
  last_handshake_sec?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  address?: string; // the device's assigned tunnel address, e.g. "10.99.0.2/32"
  failed_checks?: Array<{ kind: string; mode: string }>;
}

declare global {
  interface Window {
    tunnex?: TunnexBridge;
  }
}

export function desktop(): TunnexBridge | null {
  return typeof window !== "undefined" && window.tunnex ? window.tunnex : null;
}

// ⛔ `isDesktop()` REMOVED (S14.20 step 4). Its callers were the six branches that made one bundle
// serve two products; the last of them went with this change, and the only surviving mention is a
// comment in `client.tsx` describing what used to be. `desktop()` stays — the client's own surface
// asks the bridge for real things.
