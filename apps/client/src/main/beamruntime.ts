import { validateRoutes, BEAM_PATH_ROUTES, beamTargetDigest } from "./beamroutes";
import * as http from "node:http";
import * as https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import {
  BeamApi,
  BeamApiError,
  nativeBinding,
  type BeamContext,
} from "./beamapi";
import { newBeamIdentity } from "./beamidentity";
import { openBeamChannel, type BeamChannelOptions } from "./beamconnector";
import type {
  BeamSharedView,
  BeamSharedShare,
  BeamAction,
  BeamCreate,
  BeamShare,
  BeamTarget,
  BeamView,
  BeamInventory,
  BeamGrantsPreview,
  BeamGrantsImpact,
} from "./beamtypes";
import { runBeamChannelPool } from "./beamchannelpool";
import { isCanonicalUuid } from "./uuid";

export function validateBeamTarget(raw: unknown): BeamTarget {
  const t = raw as BeamTarget;
  if (
    !t ||
    !["127.0.0.1", "::1"].includes(t.address) ||
    !["http", "https"].includes(t.protocol) ||
    !Number.isSafeInteger(t.port) ||
    t.port < 1 ||
    t.port > 65535 ||
    (t.ca_pem !== undefined &&
      (typeof t.ca_pem !== "string" ||
        t.ca_pem.length > 16384 ||
        !t.ca_pem.includes("BEGIN CERTIFICATE")))
  )
    throw new Error("beam_target_invalid");
  if (t.protocol === "http" && t.ca_pem) throw new Error("beam_target_invalid");
  validateRoutes(t);
  return {
    ...(t.routes?.length ? {routes:t.routes.map(route => ({path_prefix:route.path_prefix,target:validateBeamTarget(route.target)}))} : {}),
    address: t.address,
    port: t.port,
    protocol: t.protocol,
    ...(t.ca_pem ? { ca_pem: t.ca_pem } : {}),
  };
}
export async function checkBeamTarget(
  raw: unknown,
): Promise<{ ready: boolean }> {
  const target = validateBeamTarget(raw);
  const root = { ...target, routes: undefined };
  const results = await Promise.all([root, ...(target.routes ?? []).map(route => route.target)].map(checkBeamSingleTarget));
  return {ready: results.every(result => result.ready)};
}
async function checkBeamSingleTarget(target: BeamTarget): Promise<{ready:boolean}> {
  return new Promise((resolve) => {
    let completed = false;
    const done = (ready: boolean) => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        request.destroy();
        resolve({ ready });
      }
    };
    const request = (target.protocol === "https" ? https : http).request(
      {
        host: target.address,
        port: target.port,
        path: "/",
        method: "HEAD",
        agent: false,
        ca: target.ca_pem,
        rejectUnauthorized: true,
        maxHeaderSize: 32768,
      },
      (response) => {
        response.destroy();
        done(true);
      },
    );
    const timer = setTimeout(() => done(false), 1500);
    request.on("error", () => done(false));
    request.end();
  });
}
export function canonicalBeamUrl(share: Pick<BeamShare, "url" | "hostname">): string {
  const u = new URL(share.url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hostname !== share.hostname ||
    u.port ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("beam_url_invalid");
  return u.href;
}
interface Running {
  share: BeamShare;
  api: BeamApi;
  abort: AbortController;
  status: NonNullable<BeamShare["local_status"]>;
  lastContact?: string;
  options?: BeamChannelOptions;
  channels: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  certificateExpiresAt?: number;
}
// App-lifetime owner. No persistence of connector private keys and no restart resurrection.
export class BeamRuntime {
  private running = new Map<string, Running>();
  private epoch = 0;
  private clockOffset = 0;
  private listeners = new Set<() => void>();
  private emitTimer?: ReturnType<typeof setTimeout>;
  private openedShares = new Set<string>();
  private reviewObserved = new Map<string, {scope:string; share:BeamSharedShare; episode:string}>();
  constructor(
    private readonly context: () => Promise<BeamContext>,
    private readonly connect = openBeamChannel,
    private readonly openedStore?: {has(key: string): boolean; mark(key: string): void},
    private readonly onAccessRevoked?: (context:BeamContext, share:BeamSharedShare, episode:string)=>void,
  ) {}
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      for (const cb of this.listeners) {
        try {
          cb();
        } catch {
          /* detached view */
        }
      }
    }, 250);
  }
  activeCount(): number {
    return this.running.size;
  }
  private async api(): Promise<BeamApi> {
    return new BeamApi(await this.context());
  }
  private project(share: BeamShare): BeamShare {
    const running = this.running.get(share.id);
    if (running && running.share.version > share.version) share = running.share;
    return {
      ...share,
      local_status:
        ["active", "starting"].includes(share.state) && running
          ? running.status
          : "offline",
      ...(running?.lastContact ? { last_contact: running.lastContact } : {}),
    };
  }
  async view(input?: BeamInventory): Promise<BeamView> {
    const api = await this.api();
    const view = this.observeView(await api.view(input));
    for (const running of this.running.values()) {
      try {
        running.api.context.assertCurrent();
      } catch {
        this.close(running.share.id);
        continue;
      }
      let share = view.shares.find((item) => item.id === running.share.id);
      if (!share && input) {
        try {
          share = await api.ownShare(running.share.id);
        } catch (error) {
          if (
            error instanceof BeamApiError &&
            [403, 404, 410].includes(error.status)
          )
            this.close(running.share.id);
          else throw error;
          continue;
        }
      }
      if (share && share.version < running.share.version) continue;
      if (
        !share ||
        !["active", "starting"].includes(share.state) ||
        Date.parse(share.expires_at) <= this.now()
      )
        this.close(running.share.id);
      else this.updateShare(running, share);
    }
    return { ...view, shares: view.shares.map((share) => this.project(share)) };
  }
  async check(target: unknown): Promise<{ ready: boolean }> {
    const api = await this.api();
    const policy = this.observeView(await api.view()).policy;
    if (!policy.can_publish) throw new Error("beam_publishing_denied");
    api.context.assertCurrent();
    const result = await checkBeamTarget(target);
    api.context.assertCurrent();
    return result;
  }
  async create(raw: BeamCreate): Promise<BeamShare> {
    const target = validateBeamTarget(raw.target);
    if (raw.project_id !== undefined && !isCanonicalUuid(raw.project_id)) throw new Error("beam_create_invalid");
    if (
      typeof raw.name !== "string" ||
      !raw.name.trim() ||
      raw.name.length > 120 ||
      !Number.isSafeInteger(raw.duration_seconds) ||
      raw.duration_seconds <= 0 ||
      !isCanonicalUuid(raw.idempotency_key)
    )
      throw new Error("beam_create_invalid");
    this.validateGrants(raw.grants);
    const input: BeamCreate = {
      ...(raw.project_id ? {project_id:raw.project_id} : {}),
      name: raw.name.trim(),
      target,
      duration_seconds: raw.duration_seconds,
      idempotency_key: raw.idempotency_key,
      grants: raw.grants.map((grant) => ({
        subject_kind: grant.subject_kind,
        subject_id: grant.subject_id,
      })),
    };
    const epoch = this.epoch;
    const api = await this.api();
    const policy = this.observeView(await api.view()).policy;
    if (!policy.enabled || !policy.domain_ready || !policy.can_publish)
      throw new Error("beam_publishing_denied");
    if (raw.project_id && !policy.capabilities?.includes("saved_projects_v1")) throw new Error("beam_protocol_unsupported");
    if (target.routes?.length && !policy.capabilities?.includes(BEAM_PATH_ROUTES)) throw new Error("beam_protocol_unsupported");
    if (!(await checkBeamTarget(target)).ready)
      throw new Error("beam_app_unavailable");
    if (epoch !== this.epoch) throw new Error("beam_session_changed");
    const share = await api.create(input);
    if (epoch !== this.epoch) {
      void api
        .action({ id: share.id, version: share.version, action: "stop" })
        .catch(() => {});
      throw new Error("beam_session_changed");
    }
    await this.start(share, api, epoch);
    return this.project(share);
  }
  private validateGrants(
    grants: BeamCreate["grants"],
    requireOne = true,
  ): void {
    if (
      !Array.isArray(grants) ||
      (requireOne && !grants.length) ||
      grants.length > 100 ||
      grants.some(
        (g) =>
          !g ||
          !["user", "group"].includes(g.subject_kind) ||
          !isCanonicalUuid(g.subject_id),
      )
    )
      throw new Error("beam_grants_invalid");
  }
  async action(input: BeamAction): Promise<BeamShare> {
    if (
      !isCanonicalUuid(input.id) ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      !["pause", "resume", "stop", "extend", "grants"].includes(input.action)
    )
      throw new Error("beam_action_invalid");
    if (input.action === "grants") this.validateGrants(input.grants!, false);
    const epoch = this.epoch;
    const api = await this.api();
    // Close first for withdrawal. A failed server transition stays locally offline.
    if (["pause", "stop", "resume"].includes(input.action))
      this.close(input.id);
    let share = await api.action(input);
    if (epoch !== this.epoch) throw new Error("beam_session_changed");
    if (input.action === "resume") {
      await this.start(share, api, epoch);
    }
    // Committed audience/expiry edits preserve eligible streams and serving binding.
    else if (this.running.has(share.id))
      this.updateShare(this.running.get(share.id)!, share);
    const live = this.running.get(share.id);
    if (live) share = live.share;
    return this.project(share);
  }
  async previewGrants(input: BeamGrantsPreview): Promise<BeamGrantsImpact> {
    if (
      !isCanonicalUuid(input.id) ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1
    )
      throw new Error("beam_action_invalid");
    this.validateGrants(input.grants, false);
    return (await this.api()).previewGrants(input);
  }
  async retry(id: string): Promise<void> {
    if (!isCanonicalUuid(id)) throw new Error("beam_share_invalid");
    const api = await this.api();
    const share =
      this.observeView(await api.view()).shares.find(
        (item) => item.id === id,
      ) ?? (await api.ownShare(id));
    if (!share || !["active", "starting"].includes(share.state))
      throw new Error("beam_share_terminal");
    if (this.running.has(id)) return;
    await this.start(share, api, this.epoch);
  }
  private async start(
    share: BeamShare,
    api: BeamApi,
    epoch: number,
  ): Promise<void> {
    if (
      !["active", "starting"].includes(share.state) ||
      Date.parse(share.expires_at) <= this.now()
    )
      throw new Error("beam_share_terminal");
    canonicalBeamUrl(share);
    validateBeamTarget(share.target);
    const running: Running = {
      share,
      api,
      abort: new AbortController(),
      status: "starting",
      channels: 0,
    };
    this.running.set(share.id, running);
    this.updateShare(running, share);
    this.emit();
    try {
      const identity = newBeamIdentity();
      const issued = await api.bootstrap(share, identity.csr);
      if (epoch !== this.epoch || running.abort.signal.aborted)
        throw new Error("beam_session_changed");
      if (issued.binding.purpose !== "beam_proxy" || issued.binding.digest !== beamTargetDigest(share.target))
        throw new Error("beam_binding_invalid");
      if (
        !Number.isSafeInteger(issued.share_version) ||
        issued.share_version <= share.version
      )
        throw new Error("beam_share_version_invalid");
      const binding = nativeBinding(issued.binding);
      if (
        binding.orgId !== api.context.orgId ||
        binding.shareId !== share.id ||
        binding.hostname !== share.hostname
      )
        throw new Error("beam_binding_invalid");
      const certificateExpiresAt = Date.parse(issued.certificate_expires_at);
      if (
        !Number.isFinite(certificateExpiresAt) ||
        certificateExpiresAt <= this.now()
      )
        throw new Error("beam_certificate_expiry_invalid");
      running.certificateExpiresAt = certificateExpiresAt;
      this.updateShare(running, { ...share, version: issued.share_version });
      running.options = {
        proxyUrl: issued.proxy_url,
        proxyServerName: issued.proxy_server_name,
        binding,
        target: share.target,
        identity: {
          key: identity.key,
          cert: issued.certificate_pem,
          ca: issued.ca_pem,
        },
      };
      void runBeamChannelPool(
        running.options,
        running.abort.signal,
        (status) => {
          running.channels = status.connected;
          if (!status.connected && !running.abort.signal.aborted)
            running.status = "reconnecting";
          this.emit();
        },
        this.connect,
      );
      void this.heartbeat(running);
    } catch (error) {
      this.close(share.id);
      throw error;
    }
  }
  private current(r: Running): void {
    r.api.context.assertCurrent();
    if (
      r.abort.signal.aborted ||
      this.running.get(r.share.id) !== r ||
      !["active", "starting"].includes(r.share.state) ||
      Date.parse(r.share.expires_at) <= this.now()
    )
      throw new Error("beam_share_terminal");
  }
  private now(): number {
    return Date.now() + this.clockOffset;
  }
  private observeView(view: BeamView): BeamView {
    const time = Date.parse(view.server_time);
    if (Number.isFinite(time)) this.clockOffset = time - Date.now();
    return view;
  }
  private updateShare(r: Running, share: BeamShare): void {
    if (share.version < r.share.version) return;
    r.share = share;
    clearTimeout(r.expiryTimer);
    if (!["active", "starting"].includes(share.state)) {
      this.close(share.id);
      return;
    }
    const expires = Math.min(
      Date.parse(share.expires_at),
      Date.parse(r.api.context.expiresAt),
      r.certificateExpiresAt ?? Infinity,
    );
    if (!Number.isFinite(expires)) {
      this.close(share.id);
      throw new Error("beam_expiry_invalid");
    }
    r.expiryTimer = setTimeout(
      () => this.close(share.id),
      Math.min(2147483647, Math.max(0, expires - this.now())),
    );
  }
  private async heartbeat(r: Running): Promise<void> {
    while (!r.abort.signal.aborted) {
      try {
        this.current(r);
        const ready = (await checkBeamTarget(r.share.target)).ready;
        this.current(r);
        const share = await r.api.heartbeat(
          r.share.id,
          r.options!.binding.generation,
          ready,
        );
        this.current(r);
        this.updateShare(r, share);
        r.lastContact = new Date().toISOString();
        r.status =
          ready && r.channels > 0 && share.connectivity === "online"
            ? "live"
            : ready
              ? "starting"
              : "app_unavailable";
        this.emit();
      } catch (error) {
        if (
          error instanceof BeamApiError &&
          [401, 403, 404, 409, 410].includes(error.status)
        ) {
          this.close(r.share.id);
          break;
        }
        try {
          this.current(r);
        } catch {
          this.close(r.share.id);
          break;
        }
        r.status = "offline";
        this.emit();
      }
      await this.wait(2000, r.abort.signal);
    }
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  close(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.abort.abort();
    clearTimeout(r.expiryTimer);
    r.options = undefined;
    this.running.delete(id);
    this.emit();
  }
  async retire(): Promise<void> {
    this.epoch++;
    const running = [...this.running.values()];
    for (const r of running) this.close(r.share.id);
    await Promise.race([
      Promise.allSettled(
        running.map((r) =>
          r.api.action({
            id: r.share.id,
            version: r.share.version,
            action: "stop",
          }),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  async url(id: string): Promise<string> {
    if (!isCanonicalUuid(id)) throw new Error("beam_share_invalid");
    const share = await (await this.api()).ownShare(id);
    return canonicalBeamUrl(share);
  }
  async shared(input?: BeamInventory): Promise<BeamSharedView> {
    const api = await this.api();
    const view = await api.shared(input);
    this.rememberReviews(api.context, view.shares);
    const clock = Date.parse(view.server_time);
    if (Number.isFinite(clock)) this.clockOffset = clock - Date.now();
    return view;
  }
  async sharedURL(id: string): Promise<string> {
    if (!isCanonicalUuid(id)) throw new Error("beam_share_invalid");
    const share = await (await this.api()).sharedShare(id);
    if (!share.can_open || share.state !== "active" || share.connectivity !== "online")
      throw new Error("beam_shared_access_unavailable");
    return canonicalBeamUrl(share);
  }
  private reviewKey(context: BeamContext, id: string): string {
    return createHash("sha256").update(JSON.stringify([context.server, context.userId, context.orgId, id])).digest("hex");
  }
  private reviewScope(context:BeamContext):string {return this.reviewKey(context, "review-scope");}
  private rememberReviews(context:BeamContext, shares:BeamSharedShare[]):void {
    if (!this.onAccessRevoked) return;
    for (const share of shares) {
      if (!isCanonicalUuid(share.id) || !share.can_open || share.state !== "active") continue;
      const key = this.reviewKey(context, share.id);
      const prior = this.reviewObserved.get(key);
      this.reviewObserved.set(key, {scope:this.reviewScope(context),share,episode:prior?.episode ?? randomUUID()});
    }
    while (this.reviewObserved.size > 100) this.reviewObserved.delete(this.reviewObserved.keys().next().value!);
  }
  private async checkReviewWithdrawals(api:BeamApi, visible:Set<string>, now:number):Promise<void> {
    if (!this.onAccessRevoked) return;
    const scope = this.reviewScope(api.context);
    const pending = [...this.reviewObserved.entries()].filter(([,entry])=>entry.scope === scope && !visible.has(entry.share.id)).slice(0,20);
    for (const [key,entry] of pending) {
      if (!(Date.parse(entry.share.expires_at) > now)) {this.reviewObserved.delete(key);continue;}
      let revoked = false;
      try {
        const current = await api.sharedShare(entry.share.id);
        revoked = current.state === "revoked" || (!current.can_open && current.state === "active" && current.connectivity === "online" && Date.parse(current.expires_at) > now);
        if (["stopped","expired"].includes(current.state)) this.reviewObserved.delete(key);
      } catch (error) {
        api.context.assertCurrent();
        revoked = error instanceof BeamApiError && [403,404].includes(error.status);
      }
      if (revoked) {api.context.assertCurrent();this.onAccessRevoked(api.context,entry.share,entry.episode);this.reviewObserved.delete(key);}
    }
  }
  async notifications(): Promise<BeamSharedView> {
    const api = await this.api();
    const unread: BeamSharedView["shares"] = [];
    let offset = 0;
    let view: BeamSharedView;
    const visible = new Set<string>();
    do {
      view = await api.shared({offset});
      this.rememberReviews(api.context, view.shares);
      for (const share of view.shares) visible.add(share.id);
      const now = Date.parse(view.server_time);
      for (const share of view.shares) {
        const key = this.reviewKey(api.context, share.id);
        if (share.can_open && share.state === "active" && share.connectivity === "online" && Date.parse(share.expires_at) > now &&
            !(this.openedStore?.has(key) ?? this.openedShares.has(key))) unread.push(share);
      }
      offset += view.page.limit;
    } while (view.page.has_next && view.page.limit > 0 && offset <= 10000 && unread.length < 20);
    api.context.assertCurrent();
    await this.checkReviewWithdrawals(api,visible,Date.parse(view.server_time));
    return {shares: unread.slice(0, 20), server_time: view.server_time, page: {offset: 0, limit: 20, has_next: unread.length > 20 || view.page.has_next}};
  }
  async openShared(id: string, open: (url: string) => Promise<void>): Promise<void> {
    if (!isCanonicalUuid(id)) throw new Error("beam_share_invalid");
    const api = await this.api();
    let share:BeamSharedShare;
    try {share = await api.sharedShare(id);} catch (error) {
      api.context.assertCurrent();
      const key = this.reviewKey(api.context,id), entry = this.reviewObserved.get(key);
      if (entry && error instanceof BeamApiError && [403,404].includes(error.status)) {this.onAccessRevoked?.(api.context,entry.share,entry.episode);this.reviewObserved.delete(key);}
      throw error;
    }
    if (!share.can_open || share.state !== "active" || share.connectivity !== "online") {
      const key = this.reviewKey(api.context,id), entry = this.reviewObserved.get(key);
      if (entry && (share.state === "revoked" || (share.state === "active" && share.connectivity === "online" && Date.parse(share.expires_at) > Date.now()+this.clockOffset))) {this.onAccessRevoked?.(api.context,entry.share,entry.episode);this.reviewObserved.delete(key);}
      throw new Error("beam_shared_access_unavailable");
    }
    await open(canonicalBeamUrl(share));
    api.context.assertCurrent();
    const key = this.reviewKey(api.context, id);
    if (this.openedStore) this.openedStore.mark(key); else this.openedShares.add(key);
    this.emit();
  }
  newIdempotencyKey(): string {
    return randomUUID();
  }
}
