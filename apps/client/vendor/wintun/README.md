# wintun.dll — vendored, committed, verified

`apps/client/scripts/stage-helper.sh` copies this into `build/helper/` so electron-builder bundles it
at `resources/helper/wintun.dll`. The Windows helper loads it at runtime —
`apps/helper/backend_windows.go` calls `tun.CreateTUN("tunnex", …)`, which cannot succeed without it.

| field | value |
| --- | --- |
| version | **wintun 0.14.1** (amd64) |
| sha256 | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |
| source | https://www.wintun.net/builds/wintun-0.14.1.zip → `bin/amd64/wintun.dll` |
| licence | MIT — Wintun additionally carries its own redistribution terms; see `NOTICE` |
| modified | no — prebuilt and unmodified as published |

## Why this file was missing, and why the rule is anchored

The monorepo's `.gitignore` had an **unanchored** `vendor/` rule, which matched
`apps/client/vendor/`. The DLL therefore could never be committed, while
`stage-helper.sh` described it as "committed, MIT — see vendor/wintun/README.md" and pointed at
a README that did not exist.

`stage-helper.sh` only **warns** when it is absent and then continues, so the failure was silent:
CI produced a green Windows installer shipping no DLL — an installer that installs cleanly and
then cannot bring up a tunnel. The built `.exe` was confirmed to contain zero references to it.

The rule is anchored in this repository (`/vendor/`, `apps/*/vendor/`, with
`!apps/client/vendor/`) so this file stays committed.

## Bumping it

Download the new build from wintun.net, replace this file, and update the version and sha256 above
in the same commit — so the bump is a reviewable diff rather than a silent binary swap.
