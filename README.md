# Tunnex Desktop

The Tunnex desktop client: an Electron shell, its renderer, and the root privilege helper that
owns WireGuard and the kill-switch.

Extracted from the `tunnexio/tunnex` monorepo. This repository builds and packages installers on
its own — no tunnex checkout required.

## Layout

The directory layout deliberately **mirrors the monorepo**, because packaging resolves sibling
paths: `electron-builder.yml` reads `../web/dist`, and `scripts/stage-helper.sh` builds
`../../helper`. Flattening the tree means rewriting both.

```
apps/client     Electron main + preload. The shell: tunnel orchestration, helper IPC,
                tray, monitors, session lifecycle, packaging config.
apps/helper     Go privilege helper (root). macOS pf + Windows WFP kill-switches, wintun.
                Its own Go module; builds and tests standalone.
apps/web        The renderer. Vite emits two entries; the client loads `client.html` and
                the dashboard entry is excluded from the package (see below).
packages/shared Generated API types and design tokens, consumed by the renderer build.
```

## Build

```bash
pnpm install                 # electron's postinstall needs pnpm.onlyBuiltDependencies
make gates                   # everything CI checks
make pack-mac                # → apps/client/release/Tunnex-macOS-universal.pkg
make pack-win                # → Tunnex-Windows-x64.exe  (MUST run natively on Windows)
```

⛔ **The Windows installer must be built on Windows.** A macOS-cross-built NSIS uninstaller fails
its integrity check on the target machine.

## Things that are load-bearing and look like details

**`pnpm.onlyBuiltDependencies: ["electron", "esbuild"]`** in the root `package.json`. Without it
electron's postinstall never runs and there is no binary to launch.

**The `!apps/client/build/` un-ignore** in `.gitignore`. An unanchored `build/` rule otherwise
swallows `installer.nsh`, the macOS `postinstall`, the tray PNGs and `icon.png` — packaging
*source*, not build output.

**The dashboard is excluded from the package, on purpose.** `apps/web` builds both the admin SPA
and the client renderer; `electron-builder.yml` filters out `index.html` and `assets/index-*` so
the admin bundle is not shipped as unreachable-but-readable code. `assets/brand-*` stays — the
client renders the wordmark from it. A test asserts these filters.

**macOS ships a `.pkg`, not a `.dmg`, and that is a security decision.** The root `postinstall`
installs the LaunchDaemon at install time (one admin prompt, not one per connect), and
pkg-installed files are not quarantined — so there is no App Translocation and the helper's
path-based caller authentication stays valid. `isRelocatable: false` protects that.

**`apps/helper/internal/wfp/` is a pinned, diverged fork** of `wireguard/windows` tunnel/firewall
@ v1.0.1 with three approved behavioural deltas. `VENDOR.md` records an **upstream-sync
obligation**: on any bump of `golang.zx2c4.com/wireguard/windows`, re-diff and re-apply the deltas
as a separate reviewed change, so an upstream filter-set security patch is not missed.

## ⛔ Known broken: `wintun.dll` is absent

The Windows installer builds green and ships **no `wintun.dll`**, which the helper needs at
runtime to create the tun adapter. `stage-helper.sh` warns and continues. See
`apps/client/vendor/wintun/README.md` for what to download and commit.

## Relationship to the tunnex monorepo

Unsigned builds only — no Developer ID, no notarization, no auto-update feed. `electron-updater`
is a dependency but no publish feed is configured.

The renderer sources here are a **copy** of `apps/web`, which also lives in the monorepo and
serves the SaaS dashboard. Both trees can drift. Two specific couplings to watch:

- `packages/shared/src/api.d.ts` and `generated/tokens.*` are generated upstream from
  `openapi/openapi.yaml` and `tokens.ts`. They are vendored here as committed snapshots; nothing
  regenerates them in this repository.
- `apps/client/src/main/helperclient.ts` is a hand-written mirror of the Go helper's wire format
  ("4-byte BE length + JSON body", per `apps/helper/ipc.go`). There is no codegen. Both halves are
  in this repo, so a change touches both — which is the reason the helper travelled with the shell.

## Licence

Apache-2.0 — see `LICENSE`. `NOTICE` carries the third-party attributions, including the WireGuard
and Wintun MIT terms the packaged artifacts inherit, and the Lucide ISC icons the renderer uses.
No proprietary Tunnex Enterprise code is present in this repository.
