import { controlPlaneRequest } from "./controlplanerequest";
import type {
  BeamSharedShare,
  BeamSharedView,
  BeamAction,
  BeamCreate,
  BeamShare,
  BeamView,
  BeamInventory,
  BeamPolicy,
  BeamGrantsPreview,
  BeamGrantsImpact,
} from "./beamtypes";
import type { BeamBinding } from "./beamconnector";
export interface BeamIssued {
  share_version: number;
  binding: {
    purpose: string;
    org_id: string;
    gateway_id: string;
    app_id: string;
    generation: string;
    revision: number;
    digest: string;
    hostname: string;
    authority_version: number;
  };
  proxy_url: string;
  proxy_server_name?: "tunnex-beam-proxy";
  ca_pem: string;
  certificate_pem: string;
  expires_at: string;
  certificate_expires_at: string;
}
const clientVersion = (require("../../package.json") as { version: string })
  .version;
function versionParts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("beam_protocol_unsupported");
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error("beam_protocol_unsupported");
  return parts;
}
export function requireBeamClientVersion(
  minimum: string,
  current = clientVersion,
): void {
  const required = versionParts(minimum),
    installed = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (installed[i] > required[i]) return;
    if (installed[i] < required[i]) throw new Error("beam_update_required");
  }
}
export function nativeBinding(b: BeamIssued["binding"]): BeamBinding {
  return {
    orgId: b.org_id,
    connectorId: b.gateway_id,
    shareId: b.app_id,
    generation: b.generation,
    revision: b.revision,
    targetDigest: b.digest,
    hostname: b.hostname,
    authorityVersion: b.authority_version,
  };
}

export interface BeamContext {
  server: string;
  token: string;
  orgId: string;
  userId: string;
  expiresAt: string;
  assertCurrent(): void;
}
export class BeamApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
async function responseJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("beam_response_invalid");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) throw new Error("beam_response_limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class BeamApi {
  constructor(readonly context: BeamContext) {}
  async request<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    this.context.assertCurrent();
    const base = `${this.context.server}/api/v1/organizations/${this.context.orgId}/beam`;
    const result = await controlPlaneRequest(
      base + route,
      {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.context.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      async (response) => {
        if (!response.ok) {
          let code = `beam_http_${response.status}`;
          try {
            const error = (await responseJSON(response)) as {
              error?: { code?: string };
            };
            if (
              typeof error.error?.code === "string" &&
              /^[a-z0-9_]{1,100}$/.test(error.error.code)
            )
              code = error.error.code;
          } catch {
            /* safe bounded code */
          }
          throw new BeamApiError(code, response.status);
        }
        return response.status === 204
          ? (undefined as T)
          : ((await responseJSON(response)) as T);
      },
    );
    this.context.assertCurrent();
    return result;
  }
  async view(input?: BeamInventory): Promise<BeamView> {
    const offset = input?.offset ?? 0,
      query = input?.query ?? "";
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      typeof query !== "string" ||
      query.length > 120
    )
      throw Error("beam_inventory_invalid");
    const route = input
      ? `/shares?limit=20&offset=${offset}&q=${encodeURIComponent(query)}&scope=active&state=active&connectivity=online`
      : "/shares";
    const [policy, audience, shares] = await Promise.all([
      this.request<BeamPolicy>("/policy"),
      this.request<{
        users: Array<{ id: string; name: string; email?: string }>;
        groups: Array<{ id: string; name: string }>;
      }>("/audience"),
      this.request<{
        items: BeamShare[];
        server_time: string;
        offset?: number;
        limit?: number;
        quota?: { active_shares: number; max_shares: number };
      }>(route),
    ]);
    if (policy.protocol_version !== undefined && policy.protocol_version !== 1)
      throw new Error("beam_protocol_unsupported");
    if (policy.min_client_version !== undefined)
      requireBeamClientVersion(policy.min_client_version);
    return {
      policy: {
        ...policy,
        default_duration_seconds: Math.min(7200, policy.max_duration_seconds),
        audience: [
          ...(audience.users ?? []).map((user) => ({
            subject_kind: "user" as const,
            subject_id: user.id,
            name: user.name || user.email || user.id,
          })),
          ...(audience.groups ?? []).map((group) => ({
            subject_kind: "group" as const,
            subject_id: group.id,
            name: group.name,
          })),
        ],
      },
      shares: shares.items
        .filter((share) => share.publisher_id === this.context.userId)
        .map((share) => ({ ...share, grants: share.grants ?? [] })),
      server_time: shares.server_time,
      ...(shares.quota ? { quota: shares.quota } : {}),
      page: {
        offset: shares.offset ?? offset,
        limit: shares.limit ?? (input ? 20 : 50),
        has_next: shares.items.length === (shares.limit ?? (input ? 20 : 50)),
      },
    };
  }
  async shared(input: BeamInventory = {}): Promise<BeamSharedView> {
    const offset = input?.offset ?? 0, query = input?.query ?? "";
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || typeof query !== "string" || query.length > 120)
      throw Error("beam_inventory_invalid");
    const result = await this.request<{items: BeamSharedShare[]; server_time: string; limit: number; offset: number}>(
      `/shared?limit=20&offset=${offset}&q=${encodeURIComponent(query)}&scope=active&state=active&connectivity=online`,
    );
    // Explicit projection: no origin target, audience, connector or credential
    // fields cross the reviewer IPC, including future server DTO additions.
    return {shares: result.items.map(reviewerProjection), server_time: result.server_time,
      page: {offset: result.offset, limit: result.limit, has_next: result.items.length === result.limit}};
  }
  async sharedShare(id: string): Promise<BeamSharedShare> {
    return reviewerProjection(await this.request<BeamSharedShare>(`/shares/${id}`));
  }
  async ownShare(id: string): Promise<BeamShare> {
    const share = await this.request<BeamShare>(`/shares/${id}`);
    if (share.publisher_id !== this.context.userId)
      throw Error("beam_share_unavailable");
    return { ...share, grants: share.grants ?? [] };
  }
  create(input: BeamCreate): Promise<BeamShare> {
    return this.request("/shares", "POST", input);
  }
  action(input: BeamAction): Promise<BeamShare> {
    const { id, version } = input;
    return input.action === "grants"
      ? this.request(`/shares/${id}/grants`, "PUT", {
          grants: input.grants,
          expected_version: version,
          ...(input.confirm_reviewer_removal === true
            ? { confirm_reviewer_removal: true }
            : {}),
        })
      : this.request(`/shares/${id}/actions`, "POST", {
          action: input.action,
          expected_version: version,
          ...(input.action === "extend"
            ? { expires_at: input.expires_at }
            : {}),
        });
  }
  previewGrants(input: BeamGrantsPreview): Promise<BeamGrantsImpact> {
    return this.request(`/shares/${input.id}/grants/impact`, "POST", {
      expected_version: input.version,
      grants: input.grants,
    });
  }
  bootstrap(share: BeamShare, csr: string): Promise<BeamIssued> {
    return this.request(`/shares/${share.id}/connector`, "POST", {
      expected_version: share.version,
      csr_pem: csr,
      capabilities: ["path_routes_v1"],
    });
  }
  heartbeat(
    id: string,
    generation: string,
    ready: boolean,
  ): Promise<BeamShare> {
    return this.request(`/shares/${id}/heartbeat`, "POST", {
      generation,
      origin_ready: ready,
    });
  }
}

function reviewerProjection(share: BeamSharedShare): BeamSharedShare {
  return {id: share.id, name: share.name, hostname: share.hostname, url: share.url,
    publisher_name: share.publisher_name, state: share.state, connectivity: share.connectivity,
    can_open: share.can_open, expires_at: share.expires_at};
}
