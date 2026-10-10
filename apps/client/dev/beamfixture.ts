// Synthetic local application used only by the Beam development spike/tests.
import * as http from "node:http";
import { createHash } from "node:crypto";

export async function startBeamFixtureApp(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      let count = 0;
      const timer = setInterval(() => res.write(`data: local-${++count}\n\n`), 80);
      res.once("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/headers") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(req.headers)); return; }
    if (req.url === "/escape") { res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }).end(); return; }
    if (req.url === "/wide-cookie") { res.writeHead(200, { "Set-Cookie": "app=secret; Domain=.example" }).end("refused cookie"); return; }
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/review" }).end(); return; }
    if (req.url === "/echo-body") { req.pipe(res); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Beam local review app</title><style>body{font:18px system-ui;background:#eef6f1;color:#173b2d;padding:40px}main{max-width:640px;margin:auto}button{padding:10px}</style><main><p>Tunnex Beam · local application fixture</p><h1>Your local app is reaching the browser</h1><p>This HTML came from a fixed laptop loopback port through the authenticated outbound connector.</p><p id="live">Waiting for a live SSE event…</p><button onclick="location.reload()">Reload the app</button><script>const events=new EventSource('/events');events.onmessage=e=>document.getElementById('live').textContent='Live stream: '+e.data;events.onerror=()=>document.getElementById('live').textContent='Stream disconnected. Check Beam authority or connectivity.';</script></main></html>`);
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/echo" || !req.headers["sec-websocket-key"]) { socket.destroy(); return; }
    const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = head;
    socket.on("error", () => {});
    const read = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 6) return;
      const size = buffered[1] & 0x7f;
      if (size > 125 || !(buffered[1] & 0x80)) { socket.destroy(); return; }
      if (buffered.length < 6 + size) return;
      const payload = Buffer.from(buffered.subarray(6, 6 + size));
      for (let i = 0; i < size; i++) payload[i] ^= buffered[2 + i % 4];
      socket.write(Buffer.concat([Buffer.from([0x81, size]), payload]));
      buffered = buffered.subarray(6 + size);
    };
    socket.on("data", read);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}
