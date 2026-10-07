import { createHash } from "node:crypto";
import type { ReleaseCheck } from "./releaseview";

export type NoticeKind = "access_revoked" | "device_revoked" | "update_available";
export interface ClientNotice { id: string; kind: NoticeKind; title: string; body: string; created_at: string; }
export interface StoredNotice extends ClientNotice { scope: string; read: boolean; }
export function notificationScope(server: string, token: string): string {
  return createHash("sha256").update(JSON.stringify([server, token])).digest("hex");
}

// Local inbox of authoritative events. Notification storage must never prevent
// revocation teardown. Neither a token nor a URL is persisted or projected.
export class NotificationInbox {
  private entries: StoredNotice[] = [];
  private listeners = new Set<() => void>();
  constructor(private readonly persistence: {read(): StoredNotice[]; write(entries: StoredNotice[]): void}, private readonly currentScope: () => string | null) {
    try {const stored = persistence.read(); if (Array.isArray(stored)) this.entries = stored.slice(-100);} catch { /* optional local inbox */ }
  }
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => this.listeners.delete(listener);}
  private save(): void {
    try {this.persistence.write(this.entries);} catch { /* retain in memory; never interfere with security actions */ }
    for (const listener of this.listeners) {try {listener();} catch { /* detached window */ }}
  }
  record(kind: NoticeKind, resource: string, title: string, body: string, scope = this.currentScope()): void {
    if (!scope) return;
    const id = createHash("sha256").update(JSON.stringify([scope, kind, resource])).digest("hex");
    if (this.entries.some(entry => entry.id === id)) return;
    this.entries = [...this.entries, {id, kind, title, body, scope, read:false, created_at:new Date().toISOString()}].slice(-100);
    this.save();
  }
  release(result: ReleaseCheck): void {
    if (result.kind === "unavailable") return;
    const retained = this.entries.filter(entry => entry.kind !== "update_available" || (result.kind === "available" && entry.title === `Update available: v${result.version}`));
    if (retained.length !== this.entries.length) {this.entries = retained; this.save();}
    if (result.kind === "available") this.record("update_available", result.version, `Update available: v${result.version}`, "A newer Tunnex desktop version is available. Open the official download page to update.", "global");
  }
  list(): ClientNotice[] {
    const scope = this.currentScope();
    return this.entries.filter(entry => !entry.read && (entry.scope === "global" || entry.scope === scope)).reverse().map(({id, kind, title, body, created_at}) => ({id, kind, title, body, created_at}));
  }
  markRead(id: string): void {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw Error("notification_invalid");
    const permitted = this.list().some(entry => entry.id === id);
    if (!permitted) return;
    this.entries = this.entries.map(entry => entry.id === id ? {...entry, read:true} : entry);
    this.save();
  }
}
