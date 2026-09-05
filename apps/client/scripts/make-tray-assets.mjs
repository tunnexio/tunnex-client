// Generate the small, transparent status-bar assets used by Electron's native Tray.
// Both platforms rasterise the canonical brand SVG through Electron/Chromium.
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const here = dirname(new URL(import.meta.url).pathname);
const out = join(here, "..", "build", "tray");

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const kind = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  kind.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([kind, data])), data.length + 8);
  return result;
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    rows[target] = 0; // explicit no-filter rows make the asset proof portable in Node
    rgba.copy(rows, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });

// Rasterise the canonical brand SVG with the installed Electron/Chromium engine.
// The helper returns canvas pixels; our PNG encoder preserves the portable no-filter format.
const scratch = mkdtempSync(join(tmpdir(), "tunnex-tray-brand-"));
try {
  const electron = createRequire(import.meta.url)("electron");
  const result = spawnSync(electron, [join(here, "render-tray-brand.mjs"), scratch], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`brand tray render failed: ${result.status}`);
  for (const variant of ["idle", "connected"]) {
    for (const [size, suffix] of [[22, ""], [44, "@2x"], [20, "-win"], [40, "-win@2x"]]) {
      const rgba = Buffer.from(JSON.parse(readFileSync(join(scratch, `${variant}${suffix}.json`), "utf8")));
      writeFileSync(join(out, `${variant}${suffix}.png`), png(size, size, rgba));
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`tray assets: wrote 8 transparent PNGs to ${out}`);
