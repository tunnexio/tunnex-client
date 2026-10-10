// Development fixtures trust only the ephemeral core fixture CA.
import * as https from "node:https";

export function fixtureViewer(ca: string) {
  const request = (url: string, options: https.RequestOptions = {}) =>
    https.request(url, { ...options, ca, rejectUnauthorized: true, agent: false });
  const get = (url: string, options: https.RequestOptions = {}) => {
    const pending = request(url, options);
    pending.end();
    return pending;
  };
  // These buffered fixture requests inspect manual redirects; streaming SSE and
  // WebSocket tests use get/request directly and retain their native backpressure.
  const fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    if (new URL(url).protocol === "http:") return globalThis.fetch(url, init);
    if (init.body != null && typeof init.body !== "string") throw Error("fixture body must be text");
    return new Promise((resolve, reject) => {
      const outgoing: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => { outgoing[name] = value; });
      const pending = request(url, {
        method: init.method,
        headers: outgoing,
        signal: init.signal ?? undefined,
      });
      pending.once("error", reject);
      pending.once("response", response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const status = response.statusCode ?? 500;
          const body = init.method === "HEAD" || [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
          resolve(new Response(body, { status, headers }));
        });
      });
      pending.end(init.body ?? undefined);
    });
  };
  return { request, get, fetch };
}
