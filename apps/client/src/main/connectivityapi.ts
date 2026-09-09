// Main-process only. The helper receives scoped TURN/ICE material, never the
// user's CP bearer credential. Callers must hold the existing managed lease.
import { controlPlaneRequest } from "./controlplanerequest";
import { isCanonicalUuid } from "./uuid";
import type { TunnelConfig } from "./helperclient";

// Re-read the owner-scoped volatile dial on each relay Connect. Never persist
// it over the enrolled device's private identity or use a monitor's stale hint.
export async function prepareRelayConnectivity(origin: string, token: string, binding: ConnectivityBinding,
  config: TunnelConfig, readDial: () => Promise<{ dial: { endpoint: string; pubkey: string } | null }>,
  assertCurrent: () => void): Promise<ConnectivityApi | null> {
  assertCurrent();
  if (!await new ConnectivityApi(origin, token, binding).enabled()) return null;
  assertCurrent();
  const { dial } = await readDial();
  assertCurrent();
  if (dial) {
    if (!key(dial.pubkey) || typeof dial.endpoint !== "string" || dial.endpoint.length > 512 ||
      !/^[^\s\x00-\x1f]+:\d{1,5}$/.test(dial.endpoint)) throw invalid();
    config.endpoint = dial.endpoint;
    config.peer_public_key = dial.pubkey;
  }
  return new ConnectivityApi(origin, token, { ...binding, gatewayPublicKey: config.peer_public_key });
}

export interface ConnectivityBinding {
  orgId: string; deviceId: string; gatewayId: string;
  devicePublicKey: string; gatewayPublicKey: string;
}
export interface ConnectivitySession {
  session_id: string; device_id: string; gateway_id: string;
  device_public_key: string; gateway_public_key: string;
  generation: number; expires_at: string;
  device_sequence: number; gateway_sequence: number;
  device_payload: string; gateway_payload: string;
  relay?: { url: string; username: string; password: string; expires_at: string };
}

// An established ICE transport owns exactly one negotiated offer pair. A newer
// mailbox revision is not a renewal of that transport: it needs a fresh Connect.
export function assertNegotiatedOffersUnchanged(previous: ConnectivitySession, current: ConnectivitySession): void {
  if (current.gateway_sequence !== previous.gateway_sequence
    || current.gateway_payload !== previous.gateway_payload
    || current.device_sequence !== previous.device_sequence
    || current.device_payload !== previous.device_payload) {
    throw new Error("relay_negotiation_changed");
  }
}
const invalid = () => new Error("connectivity_invalid_response");
const key = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, "base64").length === 32;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sequence = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 64;
const snapshot = (v: unknown): boolean => typeof v === "string" && Buffer.byteLength(v, "utf8") <= 16384;

async function boundedJSON(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw invalid();
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function validateConnectivitySession(value: unknown, binding: ConnectivityBinding, previous?: ConnectivitySession): ConnectivitySession {
  if (!object(value)) throw invalid();
  const s = value;
  if (!isCanonicalUuid(s.session_id) || !isCanonicalUuid(s.gateway_id) || s.device_id !== binding.deviceId || (binding.gatewayId !== "" && s.gateway_id !== binding.gatewayId)
    || s.device_public_key !== binding.devicePublicKey || s.gateway_public_key !== binding.gatewayPublicKey
    || !key(s.device_public_key) || !key(s.gateway_public_key)
    || !Number.isSafeInteger(s.generation) || Number(s.generation) < 1
    || !sequence(s.device_sequence) || !sequence(s.gateway_sequence)
    || !snapshot(s.device_payload) || !snapshot(s.gateway_payload)
    || typeof s.expires_at !== "string" || !Number.isFinite(Date.parse(s.expires_at))
    || Date.parse(s.expires_at) <= Date.now() || Date.parse(s.expires_at) > Date.now() + 610_000) throw invalid();
  if (previous && (s.session_id !== previous.session_id || s.generation !== previous.generation
    || s.expires_at !== previous.expires_at || Number(s.device_sequence) < previous.device_sequence
    || Number(s.gateway_sequence) < previous.gateway_sequence)) throw invalid();
  if (s.relay !== undefined) {
    const r = s.relay;
    if (!object(r) || typeof r.url !== "string" || r.url.length > 512
      || !/^turns:[^\s/@#]+:\d+\?transport=tcp$/.test(r.url)
      || typeof r.username !== "string" || r.username.length < 1 || r.username.length > 512
      || typeof r.password !== "string" || r.password.length < 1 || r.password.length > 512
      || typeof r.expires_at !== "string" || !Number.isFinite(Date.parse(r.expires_at))
      || Date.parse(r.expires_at) <= Date.now() || Date.parse(r.expires_at) > Date.parse(s.expires_at)
      || Date.parse(r.expires_at) > Date.now() + 310_000) throw invalid();
  }
  return s as unknown as ConnectivitySession;
}

export class ConnectivityApi {
  private readonly base: string;
  private readonly binding: ConnectivityBinding;
  constructor(origin: string, private readonly token: string, binding: ConnectivityBinding) {
    const u = new URL(origin);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/"
      || !token || ![binding.orgId, binding.deviceId].every(isCanonicalUuid) || (binding.gatewayId !== "" && !isCanonicalUuid(binding.gatewayId))
      || !key(binding.devicePublicKey) || !key(binding.gatewayPublicKey)) throw new Error("connectivity_invalid_binding");
    this.binding = { ...binding };
    this.base = `${u.origin}/api/v1/organizations/${binding.orgId}/devices/${binding.deviceId}/connectivity-sessions`;
  }
  private async request(method: string, previous?: ConnectivitySession, body?: unknown): Promise<ConnectivitySession | null> {
    if (previous) validateConnectivitySession(previous, this.binding);
    const endpoint = previous ? `${this.base}/${previous.session_id}?generation=${previous.generation}` : this.base;
    try {
      return await controlPlaneRequest(endpoint, {
        method, redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, async (response) => {
        if (!response.ok) throw new Error(`connectivity_refused_${response.status}`);
        if (method === "DELETE" && response.status === 204) return null;
        // Bound bytes before JSON allocation. The shared request deadline also
        // covers a server that delivers headers but stalls the body.
        const parsed = await boundedJSON(response, 131072);
        return validateConnectivitySession(parsed, this.binding, previous);
      }, 12_000);
    } catch (error) {
      // Never surface a server body, token, URL credentials, or candidate data.
      if (error instanceof Error && /^connectivity_(refused_\d{3}|invalid_response)$/.test(error.message)) throw error;
      throw new Error("connectivity_control_unavailable");
    }
  }
  async enabled(): Promise<boolean> {
    const endpoint = this.base.slice(0, this.base.indexOf("/devices/")) + "/connectivity-profile";
    return controlPlaneRequest(endpoint, { method: "GET", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${this.token}` } }, async (r) => {
      if (r.status === 404) return false; // older CP: retain ordinary direct behavior
      if (!r.ok) throw new Error(`connectivity_refused_${r.status}`);
      const value = await boundedJSON(r, 4096);
      if (!object(value) || typeof value.enabled !== "boolean") throw invalid();
      return value.enabled;
    }, 12_000).catch(() => { throw new Error("connectivity_profile_unavailable"); });
  }
  async create(): Promise<ConnectivitySession> {
    const s = (await this.request("POST"))!;
    // Initial gateway identity is supplied by CP, but its WG key must already
    // match the owned tunnel config. Subsequent reads pin both identity and key.
    this.binding.gatewayId = s.gateway_id;
    return s;
  }
  async read(s: ConnectivitySession): Promise<ConnectivitySession> { return (await this.request("GET", s))!; }
  async publish(s: ConnectivitySession, payload: string): Promise<ConnectivitySession> {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { throw new Error("connectivity_invalid_snapshot"); }
    if (!snapshot(payload) || !object(parsed) || s.device_sequence >= 64) throw new Error("connectivity_invalid_snapshot");
    return (await this.request("PUT", s, { sequence: s.device_sequence + 1, payload }))!;
  }
  async close(s: ConnectivitySession): Promise<void> { await this.request("DELETE", s); }
}
