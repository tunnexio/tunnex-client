// Render the website-matching brand geometry, without a plate or an invented outline.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../web/src/assets/tunnex-logo.svg"), "utf8");
const paths = source.match(/<path\b[^>]*>[\s\S]*?<\/path>/g);
const defs = source.match(/<defs>([\s\S]*?)<\/defs>/)?.[1];
if (!paths || paths.length !== 11 || !defs) throw new Error("brand asset changed: review tray extraction");
const scratch = process.argv[2];
if (!scratch) throw new Error("missing raster output directory");
function svg(variant, size) {
  const body = variant === "idle" ? paths[0].replace('fill="url(#paint0_linear_0_1)"', 'fill="#ececec"') : paths[0];
  const cuts = paths.slice(2, 4).map(p => p.replace('fill="#0A0A0A"', 'fill="black"')).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 641 641">
  <defs>${defs}<mask id="tray-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="577" height="551"><rect width="577" height="551" fill="white"/>${cuts}</mask></defs>
  <g transform="translate(32 45)"><g mask="url(#tray-cut)">${body}</g>${paths.slice(4).join("")}</g></svg>`;
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  await win.loadURL("data:text/html,<html><body></body></html>");
  for (const variant of ["idle", "connected"]) {
    writeFileSync(join(here, "../build/tray", `${variant}.svg`), svg(variant, 44));
    for (const [size, suffix] of [[22, ""], [44, "@2x"], [20, "-win"], [40, "-win@2x"]]) {
      const uri = "data:image/svg+xml;base64," + Buffer.from(svg(variant, size)).toString("base64");
      const pixels = await win.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(uri)}; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = ${size}; canvas.height = ${size};
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, ${size}, ${size});
        return Array.from(ctx.getImageData(0, 0, ${size}, ${size}).data);
      })()`);
      writeFileSync(join(scratch, `${variant}${suffix}.json`), JSON.stringify(pixels));
    }
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
