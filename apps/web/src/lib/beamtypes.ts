// Renderer projections contain resource metadata only; identities remain in main.
export interface BeamTarget {
  address: "127.0.0.1" | "::1";
  port: number;
  protocol: "http" | "https";
  ca_pem?: string;
  routes?: Array<{path_prefix: string; target: BeamTarget}>;
}
export interface BeamAudience {
  subject_kind: "user" | "group";
  subject_id: string;
  name: string;
}
export interface BeamPolicy {
  capabilities?: string[];
  protocol_version?: number;
  min_client_version?: string;
  enabled: boolean;
  can_publish: boolean;
  domain_ready: boolean;
  reason?: string;
  max_duration_seconds: number;
  default_duration_seconds: number;
  max_shares: number;
  audience: BeamAudience[];
}
export interface BeamShare {
  id: string;
  publisher_id: string;
  created_at: string;
  name: string;
  url: string;
  hostname: string;
  target: BeamTarget;
  state: "starting" | "active" | "paused" | "stopped" | "expired" | "revoked";
  version: number;
  expires_at: string;
  grants: Array<{ subject_kind: "user" | "group"; subject_id: string }>;
  connectivity?: string;
  local_status?:
    | "starting"
    | "live"
    | "reconnecting"
    | "offline"
    | "app_unavailable";
  last_contact?: string;
}
export interface BeamCreate {
  project_id?: string;
  name: string;
  target: BeamTarget;
  duration_seconds: number;
  grants: Array<{ subject_kind: "user" | "group"; subject_id: string }>;
  idempotency_key: string;
}
export interface BeamAction {
  id: string;
  version: number;
  action: "pause" | "resume" | "stop" | "extend" | "grants";
  expires_at?: string;
  grants?: BeamCreate["grants"];
  confirm_reviewer_removal?: boolean;
}
export interface BeamGrantsPreview {
  id: string;
  version: number;
  grants: BeamCreate["grants"];
}
export interface BeamGrantsImpact {
  share_version: number;
  removed_grant_count: number;
  affected_reviewer_count: number;
  affected_reviewer_session_count: number;
  requires_confirmation: boolean;
}
export interface BeamInventory {
  offset?: number;
  query?: string;
}
export interface BeamView {
  quota?: { active_shares: number; max_shares: number };
  page?: { offset: number; limit: number; has_next: boolean };
  policy: BeamPolicy;
  shares: BeamShare[];
  server_time: string;
}

export interface BeamSharedShare {
  id: string;
  name: string;
  hostname: string;
  url: string;
  publisher_name?: string;
  state: BeamShare["state"];
  connectivity: string;
  can_open: boolean;
  expires_at: string;
}
export interface BeamSharedView {
  shares: BeamSharedShare[];
  server_time: string;
  page: { offset: number; limit: number; has_next: boolean };
}
