# NAT-0 desktop live qualification

Status: preparation only; no relay-enabled desktop product code or live VPN proof.
Client baseline: `f9d2df3` (main, v0.1.3). Companion laboratory content:
`tunnex` branch `codex/nat0-transport-proof`, commit `9982336`.

## Scope

The user authorized continuing with the real client, including development mode.
Use the real macOS helper and existing WireGuard backend. Start with narrow
split routes, not a default route or global DNS change. Reuse the laboratory
per-peer encrypted UDP bridge for qualification; authenticated CP signaling and
automatic transport selection remain later stories, not silently implemented.

Do not run a second helper alongside the installed one: startup self-heal and
stale resolver cleanup share machine-wide state. A controlled single-helper
transition must preserve caller authentication and have a restoration path.
No credentials, private keys or client profiles are committed.

## Verified preparation (2026-09-06)

- Fetched origin and created `codex/nat0-desktop-proof` from latest main.
- Client TypeScript and renderer production builds passed.
- `go test -mod=readonly ./...` in `apps/helper` passed.
- Started the real Electron development client with the compiled renderer and
  a separate temporary user-data directory. Startup log confirms launch; no
  Connect or helper installation was requested. This is not VPN acceptance.
- Installed native helper reports 0.1.0. Its LaunchDaemon trusts only the
  packaged application's executable directory, not development Electron.
- Non-interactive sudo is unavailable; macOS authentication is required for
  any controlled helper replacement. No privileged mutation was attempted.

## Approved installer finding and fold

P1: `scripts/macos-dev-install.sh` reads a rejected executable directory from
`/tmp/tunnex-helper.log` and adds it to privileged-helper caller trust. Rejected
caller/log contents must not become authorization. It also uses a predictable
temporary log path for the root daemon. Do not execute this script unchanged.

Recommended narrow disposition: remove rejected-log trust inference; derive
only explicit required caller directories, use the protected runtime log path,
and test generated trust configuration without root. Preserve packaged-app
trust during the temporary development walk. Hold for user disposition before
folding this security-sensitive installer change. The user subsequently approved
this narrow fix in-session on 2026-09-06.

Implemented: log-derived trust was removed. The generated plist trusts exactly
the driver directory, packaged app directory and canonical development Electron
directory. XML escaping and path-delimiter validation prevent trust-list/plist
injection. Missing Electron fails before installation. `--print-plist` renders
the actual install configuration without privileged changes.

The daemon log now resides at `/var/run/tunnex/helper.log`, with root-owned
runtime directory and mode-0600 file. Explicit destination symlinks are refused.
Build artifacts use a private unique temporary directory rather than fixed
`/tmp` names; that directory is retained, not automatically cleaned.

All four focused tests, shell/Node syntax and macOS `plutil` validation of the
real preview passed. Tests are wired into local gates and the CI client matrix;
remote exact-SHA CI has not run. Both independent reviewers closed the P1 with
no new actionable findings and independently passed focused tests/shell syntax.
Neither reviewers nor primary agent ran the privileged installer. No helper,
firewall, routing, DNS or installed application was changed by this fold.

## Remaining live evidence

After installer disposition and local authentication: record preflight tunnel
state, perform a controlled helper transition, connect the development client
through the relay to Linux, demonstrate blocked direct UDP and authorized versus
unauthorized service access, and restore the packaged helper configuration.
The same-container kernel proof does not satisfy these acceptance legs.
