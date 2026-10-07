import {createHash} from "node:crypto";
import type { BeamTarget } from "./beamtypes";
export const BEAM_PATH_ROUTES = "path_routes_v1";
export function validBeamPrefix(prefix: string): boolean {
 return typeof prefix === "string" && prefix.length <= 128 && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix);
}
export function validateRoutes(target: BeamTarget): void {
 if (target.routes === undefined) return;
 if (!Array.isArray(target.routes) || target.routes.length > 8) throw new Error("beam_target_invalid");
 const seen = new Set<string>();
 for (const route of target.routes) {
  if (!route || !validBeamPrefix(route.path_prefix) || seen.has(route.path_prefix) || !route.target || route.target.routes?.length) throw new Error("beam_target_invalid");
  seen.add(route.path_prefix);
 }
}
export function selectBeamTarget(target: BeamTarget, raw: string): BeamTarget {
 const path = decodeURIComponent(raw.split("?",1)[0]);
 if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f]/.test(path) || (target.routes?.length && (path.includes("//") || path.split("/").some(segment => segment === "." || segment === "..")))) throw new Error("beam_target_invalid");
 let chosen = target, length = 0;
 for (const route of target.routes ?? []) if ((path === route.path_prefix || path.startsWith(route.path_prefix + "/")) && route.path_prefix.length > length) {chosen = route.target; length = route.path_prefix.length;}
 return chosen;
}

// Match the control-plane Target JSON contract exactly, including route order.
export function beamTargetDigest(target: BeamTarget): string {
 const canonical=(t:BeamTarget):unknown=>({protocol:t.protocol,address:t.address,port:t.port,...(t.ca_pem ? {ca_pem:t.ca_pem} : {}),...(t.routes?.length ? {routes:t.routes.map(route=>({path_prefix:route.path_prefix,target:canonical(route.target)}))} : {})});
 return createHash("sha256").update(JSON.stringify(canonical(target)).replace(/[<>&\u2028\u2029]/g,char=>"\\u"+char.charCodeAt(0).toString(16).padStart(4,"0"))).digest("hex");
}
