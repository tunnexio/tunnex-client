// LS-CLIENT-1: the words Local Sharing shows people, in one electron-free module.
// Terms follow the web console: Local Sharing, share, reviewers, "Name (email)".
import type { BeamAudience, BeamPolicy, BeamShare, BeamView } from "../lib/beamtypes";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "1 minute", "15 minutes", "1 hour", "2 hours", "1 hour 30 minutes". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

/** Time left on a link, rounded up to the minute. */
export function formatRemaining(milliseconds: number): string {
  if (!(milliseconds > 30_000)) return "less than a minute";
  return formatDuration(Math.ceil(milliseconds / 60_000) * 60);
}

/** The web console's personLabel: "Name (email)", never the same address twice. */
export function personLabel(person: { name?: string | null; email?: string | null } | undefined, fallback = "Unknown person"): string {
  const name = person?.name?.trim() ?? "";
  const email = person?.email?.trim() ?? "";
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return email || name || fallback;
}

export const groupLabel = (name: string) => (/\bgroup$/i.test(name.trim()) ? name.trim() : `${name.trim()} group`);

export const audienceLabel = (subject: BeamAudience) =>
  subject.subject_kind === "group" ? groupLabel(subject.name) : personLabel(subject, subject.name);

/**
 * Who can open a share, in words. The server always grants the publisher, so that grant is
 * not a reviewer. Selections outside the current reviewer list are counted, not named.
 */
export function reviewerSummary(share: Pick<BeamShare, "grants" | "publisher_id">, audience: BeamAudience[]): string {
  const reviewers = share.grants.filter(grant => !(grant.subject_kind === "user" && grant.subject_id === share.publisher_id));
  if (!reviewers.length) return "Only you can open it. Choose Access to add reviewers.";
  const names = reviewers
    .map(grant => audience.find(subject => subject.subject_kind === grant.subject_kind && subject.subject_id === grant.subject_id))
    .filter((subject): subject is BeamAudience => !!subject)
    .map(subject => (subject.subject_kind === "group" ? groupLabel(subject.name) : subject.name));
  if (!names.length) return plural(reviewers.length, "reviewer");
  const shown = names.slice(0, 3), more = reviewers.length - shown.length;
  return `Reviewers: ${shown.join(", ")}${more ? ` +${more} more` : ""}`;
}

/** Why "New share" is unavailable, or null. The server sends no reason, so derive one. */
export function publishBlockReason(policy: BeamPolicy, quota?: BeamView["quota"]): string | null {
  const blocked = !policy.enabled || !policy.domain_ready || !policy.can_publish;
  if (blocked && policy.reason) return policy.reason;
  if (!policy.enabled) return "Local Sharing is turned off for your organization. An administrator can turn it on in the web console.";
  if (!policy.domain_ready) return "Local Sharing setup isn't finished on your server. An administrator needs to complete the sharing domain setup.";
  if (!policy.can_publish) return "Your account can open apps shared with you but can't share its own. Ask an administrator for publishing access.";
  if (quota && quota.max_shares > 0 && quota.active_shares >= quota.max_shares)
    return `You have ${plural(quota.active_shares, "active share")}, your organization's limit. Stop a share to create another.`;
  return null;
}

const validPort = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
export const validApiPrefix = (value: string) => /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value);

/** The first thing still missing before a share can be created, or null when ready. */
export function createBlockReason(input: {
  name: string; port: string; apiPort: string; apiPrefix: string; address: string;
  check: boolean | null; reviewers: number; available: number;
}): string | null {
  if (!input.name.trim()) return "Name the app reviewers will see.";
  if (!validPort(input.port)) return "Enter a port between 1 and 65535.";
  if (input.apiPort !== "" && !validPort(input.apiPort)) return "Enter an API port between 1 and 65535, or leave it empty.";
  if (input.apiPort !== "" && !validApiPrefix(input.apiPrefix)) return "Enter an API path such as /api (letters, numbers, - and _).";
  if (input.check === false) return `Your app didn't respond on ${hostPort(input.address, input.port)}. Start it, then check again.`;
  if (input.check !== true) return "Check the app first.";
  if (!input.available) return "No reviewers are available. Ask an administrator to add reviewers to the Local Sharing policy.";
  if (!input.reviewers) return "Choose at least one reviewer.";
  return null;
}

export const hostPort = (address: string, port: string | number) => (address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`);

/** Why Extend is unavailable, or null. */
export function extendBlockReason(roomSeconds: number, maxSeconds: number): string | null {
  return roomSeconds < 60 ? `Already at your organization's maximum lifetime of ${formatDuration(maxSeconds)}.` : null;
}

export type ShareStatus = "Live" | "Going live" | "Reconnecting" | "Offline" | "App not responding" | "Paused" | "Stopped" | "Expired" | "Ended";

/** What the publisher sees for their own share. */
export function shareStatus(share: BeamShare, now = Date.now()): ShareStatus {
  if (!(Date.parse(share.expires_at) > now) || share.state === "expired") return "Expired";
  if (share.state === "stopped") return "Stopped";
  if (share.state === "revoked") return "Ended";
  if (share.state === "paused") return "Paused";
  return ({
    live: "Live",
    starting: "Going live",
    reconnecting: "Reconnecting",
    offline: "Offline",
    app_unavailable: "App not responding",
  } as const)[share.local_status ?? "offline"];
}

export function shareStatusHint(status: ShareStatus): string | null {
  switch (status) {
    case "Going live": return "Connecting. Reviewers can open it once it shows Live.";
    case "Reconnecting": return "The connection dropped. Tunnex is reconnecting; keep this computer online.";
    case "Offline": return "This computer isn't serving the share. Choose Reconnect to serve reviewers again.";
    case "App not responding": return "Start your app on the same address and port. Your link and expiry stay the same.";
    case "Paused": return "Reviewers can't open it until you resume it.";
    case "Stopped": case "Expired": case "Ended": return "Create a new share to publish this app again.";
    default: return null;
  }
}

export { plural };
