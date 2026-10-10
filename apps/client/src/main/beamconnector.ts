import { validateRoutes, selectBeamTarget } from "./beamroutes";
import type { BeamTarget } from "./beamtypes";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { Transform } from "node:stream";
import { BEAM_MAX_BODY as MAX_BODY } from "./beamlimits";
import { BeamWebSocketValidator } from "./beamwebsocket";

// This is the native BM-0 transport seam. Publication credentials and actor
// authority must be supplied by Beam APIs in later stories, never by a renderer.
export interface BeamBinding {
  orgId: string;
  connectorId: string;
  shareId: string;
  generation: string;
  revision: number;
  targetDigest: string;
  hostname: string;
  authorityVersion: number;
}

export interface BeamChannelOptions {
  proxyUrl: string;
  proxyServerName?: "tunnex-beam-proxy";
  binding: BeamBinding;
  target: {
    address: "127.0.0.1" | "::1";
    port: number;
    protocol?: "http" | "https";
    ca_pem?: string;
    routes?: BeamTarget["routes"];
  };
  identity: { cert: string; key: string; ca: string };
}

export interface BeamChannel {
  close(): void;
  closed: Promise<void>;
  claimed: Promise<void>;
}

const MAX_HEADERS = 32 << 10;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STREAM = /^[a-zA-Z0-9_-]{1,128}$/;
const HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

export function beamBindingHeaders(b: BeamBinding): Record<string, string> {
  return {
    "x-app-org-id": b.orgId,
    "x-app-gateway-id": b.connectorId,
    "x-app-id": b.shareId,
    "x-app-generation": b.generation,
    "x-app-revision": String(b.revision),
    "x-app-digest": b.targetDigest,
    "x-app-hostname": b.hostname,
    "x-app-authority-version": String(b.authorityVersion),
    "x-app-purpose": "beam_proxy",
  };
}

export function validateBeamChannel(options: BeamChannelOptions): URL {
  const proxy = new URL(options.proxyUrl);
  if (
    proxy.protocol !== "https:" ||
    proxy.username ||
    proxy.password ||
    proxy.pathname !== "/" ||
    proxy.search ||
    proxy.hash
  )
    throw new Error("beam_proxy_invalid");
  if (
    options.proxyServerName !== undefined &&
    options.proxyServerName !== "tunnex-beam-proxy"
  )
    throw new Error("beam_proxy_invalid");
  const b = options.binding;
  for (const id of [b.orgId, b.connectorId, b.shareId, b.generation]) {
    if (!ID.test(id) || id === "00000000-0000-0000-0000-000000000000")
      throw new Error("beam_binding_invalid");
  }
  if (
    !Number.isSafeInteger(b.revision) ||
    b.revision < 1 ||
    !Number.isSafeInteger(b.authorityVersion) ||
    b.authorityVersion < 1 ||
    !/^[0-9a-f]{64}$/.test(b.targetDigest)
  )
    throw new Error("beam_binding_invalid");
  if (
    b.hostname.length > 253 ||
    !b.hostname.includes(".") ||
    net.isIP(b.hostname) ||
    b.hostname
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("beam_binding_invalid");
  if (
    !["127.0.0.1", "::1"].includes(options.target.address) ||
    !Number.isSafeInteger(options.target.port) ||
    options.target.port < 1 ||
    options.target.port > 65535
  )
    throw new Error("beam_target_invalid");
  if (
    options.target.protocol &&
    !["http", "https"].includes(options.target.protocol)
  )
    throw new Error("beam_target_invalid");
  validateRoutes(options.target as BeamTarget);
  for (const route of options.target.routes ?? []) {
    if (!["127.0.0.1", "::1"].includes(route.target.address) || !["http","https"].includes(route.target.protocol) || !Number.isSafeInteger(route.target.port) || route.target.port<1 || route.target.port>65535 || (route.target.ca_pem && (route.target.protocol!=="https" || route.target.ca_pem.length>16384))) throw new Error("beam_target_invalid");
  }
  if (!options.identity.cert || !options.identity.key || !options.identity.ca)
    throw new Error("beam_identity_missing");
  return proxy;
}

function reservedCookie(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("__host-tunnex_") ||
    [
      "tunnex_session",
      "tunnex_session_http",
      "__host-tnx_oidc_flow",
      "tnx_oidc_flow",
      "tnx_oidc_flow_http",
    ].includes(lower)
  );
}

function cleanHeaders(
  input: http.IncomingHttpHeaders,
  upgrade = false,
): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  const nominated = new Set(
    String(input.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim()),
  );
  for (const [key, value] of Object.entries(input)) {
    if (
      value === undefined ||
      key.startsWith("x-app-") ||
      key.startsWith("x-beam-") ||
      key.startsWith("x-tunnex-") ||
      key.startsWith("x-forwarded-") ||
      [
        "host",
        "forwarded",
        "x-real-ip",
        "remote-user",
        "proxy-authorization",
        "sec-websocket-extensions",
      ].includes(key)
    )
      continue;
    if ((!upgrade && HOP.has(key)) || (!upgrade && nominated.has(key)))
      continue;
    if (
      key === "authorization" &&
      /^(?:BeamConnector\s|AppProxy\s|Bearer\s+tnx)/i.test(String(value))
    )
      continue;
    if (key === "cookie") {
      const cookies = String(value)
        .split(";")
        .filter((cookie) => !reservedCookie(cookie.split("=", 1)[0].trim()));
      if (cookies.length) output.cookie = cookies.join(";");
    } else output[key] = value;
  }
  return output;
}

function relativePath(raw: string): boolean {
  if (
    raw.length > 8192 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\\x00-\x20\x7f#]/.test(raw)
  )
    return false;
  try {
    const decoded = decodeURIComponent(raw.split("?", 1)[0]);
    return !decoded.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(decoded);
  } catch {
    return false;
  }
}

function authorizedRequest(req: http.IncomingMessage, b: BeamBinding): boolean {
  const count = (name: string) =>
    req.rawHeaders.filter(
      (_value, index) =>
        index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name,
    ).length;
  if (
    req.headers.host !== b.hostname ||
    count("host") !== 1 ||
    !req.url ||
    !relativePath(req.url) ||
    ["CONNECT", "TRACE"].includes(req.method ?? "") ||
    !STREAM.test(String(req.headers["x-app-stream-id"] ?? "")) ||
    count("x-app-stream-id") !== 1
  )
    return false;
  return Object.entries(beamBindingHeaders(b)).every(
    ([key, value]) => count(key) === 1 && req.headers[key] === value,
  );
}

function responseHeaders(
  response: http.IncomingMessage,
  options: BeamChannelOptions,
  upgrade = false,
): http.OutgoingHttpHeaders {
  const headers = cleanHeaders(response.headers, upgrade);
  const origin = `${options.target.protocol ?? "http"}://${options.target.address === "::1" ? "[::1]" : options.target.address}:${options.target.port}`;
  if (response.headers.location) {
    const location = new URL(response.headers.location, origin);
    if (
      location.origin !== origin ||
      location.username ||
      location.password ||
      !relativePath(location.pathname + location.search)
    )
      throw new Error("beam_redirect_refused");
    headers.location = `https://${options.binding.hostname}${location.pathname}${location.search}`;
  }
  if (response.headers["set-cookie"]) {
    headers["set-cookie"] = response.headers["set-cookie"].map((raw) => {
      const parts = raw.split(";").map((part) => part.trim());
      if (reservedCookie(parts[0].split("=", 1)[0]))
        throw new Error("beam_cookie_refused");
      for (const part of parts.slice(1)) {
        if (
          /^domain=/i.test(part) &&
          part.slice(7).replace(/^\./, "").toLowerCase() !==
            options.target.address
        )
          throw new Error("beam_cookie_refused");
      }
      const scoped = parts.filter(
        (part) => !/^domain=/i.test(part) && !/^secure$/i.test(part),
      );
      return [...scoped, "Secure"].join("; ");
    });
  }
  return headers;
}

function boundedBody(): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > MAX_BODY ? new Error("beam_body_limit") : null,
        chunk,
      );
    },
  });
}

// Feed an HTTP server the outbound TLS socket after CONNECT admission. There is
// no server.listen(), local inbound listener, VPN helper or renderer credential.
export async function openBeamChannel(
  input: BeamChannelOptions,
  signal: AbortSignal,
): Promise<BeamChannel> {
  // Capture immutable copies before the asynchronous TLS handshake.
  const options = {
    ...input,
    binding: { ...input.binding },
    target: { ...input.target, ...(input.target.routes ? {routes:input.target.routes.map(route => ({path_prefix:route.path_prefix,target:{...route.target}}))} : {}) },
    identity: { ...input.identity },
  };
  const proxy = validateBeamChannel(options);
  if (signal.aborted) throw new Error("beam_cancelled");
  const upstream = new Set<http.ClientRequest | net.Socket>();
  let markClaimed!: () => void;
  let markClosed!: () => void;
  const claimed = new Promise<void>((resolve) => {
    markClaimed = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const socket = tls.connect({
    host: proxy.hostname.replace(/^\[|\]$/g, ""),
    port: Number(proxy.port || 443),
    servername:
      options.proxyServerName ??
      (net.isIP(proxy.hostname.replace(/^\[|\]$/g, ""))
        ? undefined
        : proxy.hostname),
    cert: options.identity.cert,
    key: options.identity.key,
    ca: options.identity.ca,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  const server = http.createServer({
    maxHeaderSize: MAX_HEADERS,
    requestTimeout: 30_000,
    headersTimeout: 5_000,
  });
  server.maxRequestsPerSocket = 1;
  const close = () => {
    socket.destroy();
    for (const item of upstream) item.destroy();
    server.close();
  };
  const abort = () => close();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => {
    signal.removeEventListener("abort", abort);
    for (const item of upstream) item.destroy();
    server.close();
    markClosed();
  });
  // Post-admission errors are reflected by closure, never printed with secrets.
  socket.on("error", () => {});
  server.on("clientError", (_error, client) => client.destroy());
  server.on("connect", (_req, client) => client.destroy());

  server.on("request", (req, res) => {
    markClaimed();
    if (!authorizedRequest(req, options.binding)) {
      res.writeHead(403).end("Beam request refused");
      return;
    }
    const size = Number(req.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY) {
      // Complete refusal without waiting for the rejected upload to finish.
      res.shouldKeepAlive = false;
      res.setHeader("Connection", "close");
      res.writeHead(413).end("Beam body limit");
      return;
    }
    let target: BeamTarget;
    try {target=selectBeamTarget(options.target as BeamTarget,req.url!);} catch {res.writeHead(403).end("Beam request refused");return;}
    const routedOptions = {...options,target};
    const headers = cleanHeaders(req.headers);
    headers.host = options.binding.hostname;
    headers["x-forwarded-host"] = options.binding.hostname;
    headers["x-forwarded-proto"] = "https";
    const request = (
      target.protocol === "https" ? https : http
    ).request({
      ca: target.ca_pem,
      // Public HTTP Host is independent of the immutable numeric TLS identity.
      servername: "",
      checkServerIdentity: (_hostname, certificate) =>
        tls.checkServerIdentity(target.address, certificate),
      rejectUnauthorized: true,
      host: target.address,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
      maxHeaderSize: MAX_HEADERS,
    });
    upstream.add(request);
    request.once("close", () => upstream.delete(request));
    request.once("response", (response) => {
      try {
        res.writeHead(
          response.statusCode ?? 502,
          responseHeaders(response, routedOptions),
        );
      } catch {
        response.destroy();
        res.writeHead(502).end("Beam application response refused");
        return;
      }
      const body = boundedBody();
      body.once("error", () => {
        response.destroy();
        res.destroy();
      });
      response.once("error", () => res.destroy());
      response.pipe(body).pipe(res);
    });
    request.once("error", () => {
      if (!res.headersSent) res.writeHead(502).end("Local app unavailable");
      else res.destroy();
    });
    req.once("aborted", () => request.destroy());
    res.once("close", () => request.destroy());
    const body = boundedBody();
    body.once("error", () => {
      request.destroy();
      if (!res.headersSent) res.writeHead(413).end("Beam body limit");
      else res.destroy();
    });
    req.pipe(body).pipe(request);
  });

  server.on("upgrade", (req, client, head) => {
    markClaimed();
    if (
      !authorizedRequest(req, options.binding) ||
      String(req.headers.upgrade).toLowerCase() !== "websocket" ||
      req.headers.origin !== `https://${options.binding.hostname}`
    ) {
      client.destroy();
      return;
    }
    let target: BeamTarget;
    try {target=selectBeamTarget(options.target as BeamTarget,req.url!);} catch {client.destroy();return;}
    const routedOptions = {...options,target};
    const headers = cleanHeaders(req.headers, true);
    headers.host = options.binding.hostname;
    headers["x-forwarded-host"] = options.binding.hostname;
    headers["x-forwarded-proto"] = "https";
    const request = (
      target.protocol === "https" ? https : http
    ).request({
      ca: target.ca_pem,
      // Public HTTP Host is independent of the immutable numeric TLS identity.
      servername: "",
      checkServerIdentity: (_hostname, certificate) =>
        tls.checkServerIdentity(target.address, certificate),
      rejectUnauthorized: true,
      host: target.address,
      port: target.port,
      method: "GET",
      path: req.url,
      headers,
      agent: false,
      maxHeaderSize: MAX_HEADERS,
    });
    upstream.add(request);
    request.once("error", () => client.destroy());
    request.once("response", (response) => {
      response.destroy();
      client.destroy();
    });
    request.once("upgrade", (response, origin, originHead) => {
      upstream.delete(request);
      upstream.add(origin);
      origin.once("error", () => client.destroy());
      origin.once("close", () => {
        upstream.delete(origin);
        client.destroy();
      });
      client.once("close", () => origin.destroy());
      let safe: http.OutgoingHttpHeaders;
      try {
        if (response.headers["sec-websocket-extensions"] !== undefined)
          throw new Error("beam_websocket_extensions_refused");
        safe = responseHeaders(response, routedOptions, true);
      } catch {
        origin.destroy();
        client.destroy();
        return;
      }
      client.write("HTTP/1.1 101 Switching Protocols\r\n");
      for (const [name, value] of Object.entries(safe)) {
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== undefined) client.write(`${name}: ${item}\r\n`);
      }
      client.write("\r\n");
      const toOrigin = new BeamWebSocketValidator("client");
      const toClient = new BeamWebSocketValidator("origin");
      const cleanup = () => {
        toOrigin.destroy();
        toClient.destroy();
        origin.destroy();
        client.destroy();
      };
      toOrigin.once("error", cleanup);
      toClient.once("error", cleanup);
      origin.once("close", cleanup);
      client.once("close", cleanup);
      toOrigin.pipe(origin);
      toClient.pipe(client);
      if (head.length) toOrigin.write(head);
      if (originHead.length) toClient.write(originHead);
      client.pipe(toOrigin);
      origin.pipe(toClient);
    });
    request.end();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(
        () => reject(new Error("beam_handshake_timeout")),
        5_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", data);
        socket.off("error", failed);
        socket.off("close", ended);
      };
      const failed = () => {
        cleanup();
        reject(new Error("beam_channel_refused"));
      };
      const ended = () => {
        cleanup();
        reject(new Error("beam_channel_closed"));
      };
      const data = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if ((end < 0 && buffer.length > MAX_HEADERS) || end > MAX_HEADERS) {
          failed();
          return;
        }
        if (end < 0) return;
        if (
          !/^HTTP\/1\.1 200(?: |\r\n)/.test(
            buffer.subarray(0, end).toString("ascii"),
          )
        ) {
          failed();
          return;
        }
        socket.pause();
        cleanup();
        const remainder = buffer.subarray(end + 4);
        if (remainder.length) socket.unshift(remainder);
        server.emit("connection", socket);
        socket.resume();
        resolve();
      };
      socket.once("error", failed);
      socket.once("close", ended);
      socket.on("data", data);
      socket.once("secureConnect", () => {
        const headers = beamBindingHeaders(options.binding);
        socket.write(
          `CONNECT /beam/channel HTTP/1.1\r\nHost: ${proxy.host}\r\n${Object.entries(
            headers,
          )
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("")}\r\n`,
        );
      });
    });
  } catch (error) {
    close();
    throw error;
  }
  return { close, closed, claimed };
}
