import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Refresh only from an explicit, committed core checkout. Never derive expectations
// from the desktop registry/dispositions being tested or from uncommitted source.
const checkout = process.argv[2];
if (!checkout)
  throw new Error(
    "Usage: node test/support/refresh-core-contracts.mjs /path/to/tunnex-core",
  );
const git = (...args) =>
  execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const revision = git("rev-parse", "HEAD").trim();
const source = (path) => {
  const bytes = git("show", `${revision}:${path}`);
  return {
    bytes,
    provenance: {
      repository: "tunnexio/tunnex",
      revision,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
};
const spec = source("openapi/openapi.yaml");
const operations = [];
let path;
let method;
let block = [];
const flush = () => {
  if (path && method) {
    const text = block.join("\n");
    operations.push({
      path,
      method,
      summary: /^\s+summary:\s*(.*)$/m.exec(text)?.[1] ?? "",
      edition_required: text.includes("edition_required"),
    });
  }
  method = undefined;
  block = [];
};
for (const line of spec.bytes.replace(/^\s*#.*$/gm, " ").split("\n")) {
  const matchPath = /^ {2}(\/\S+):\s*$/.exec(line);
  const matchMethod = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
  if (matchPath) {
    flush();
    path = matchPath[1];
  } else if (matchMethod) {
    flush();
    method = matchMethod[1];
  } else if (method) {
    if (/^ {4}\S/.test(line) || /^ {2}\S/.test(line)) flush();
    else block.push(line);
  }
}
flush();
if (operations.length < 100)
  throw new Error("Core operation extraction is unexpectedly empty");
const design = source("docs/design/TUNNEX-wireframe-v2.html.txt");
const banners = [
  ...design.bytes.matchAll(
    /<!--\s*=+\s*([A-Z][A-Za-z0-9 ./&\-–]{2,60})\s*=+\s*-->/g,
  ),
].map((match) => match[1].trim());
if (banners.length < 17)
  throw new Error("Core design banner extraction is unexpectedly empty");
const destination = fileURLToPath(new URL("../fixtures/", import.meta.url));
mkdirSync(destination, { recursive: true });
for (const [name, value] of [
  ["core-operation-contract.json", { provenance: spec.provenance, operations }],
  ["core-design-contract.json", { provenance: design.provenance, banners }],
]) {
  writeFileSync(`${destination}${name}`, JSON.stringify(value, null, 2) + "\n");
}
