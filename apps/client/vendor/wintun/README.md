# wintun.dll — MISSING, and the Windows data plane needs it

⛔ **THIS FILE IS NOT IN THE REPOSITORY AND THE WINDOWS INSTALLER BUILDS WITHOUT IT.**

`apps/client/scripts/stage-helper.sh` copies `wintun.dll` from this directory into
`build/helper/` so electron-builder bundles it at `resources/helper/wintun.dll`. The helper
loads it at runtime — `apps/helper/backend_windows.go` calls `tun.CreateTUN("tunnex", …)`,
which cannot succeed without it.

The script only **warns** when the DLL is absent and then continues, so this failure is
silent: CI produces a green Windows installer that cannot bring up a tunnel.

## How this happened

The monorepo's `.gitignore` had an unanchored `vendor/` rule, which matched this directory.
The DLL could therefore never be committed, and a comment in `stage-helper.sh` describing it
as "committed, MIT — see vendor/wintun/README.md" referred to a README that did not exist.
The rule is anchored in this repository so the DLL *can* be committed.

## To fix

1. Download the official Wintun release from <https://www.wintun.net> (MIT).
2. Take `bin/amd64/wintun.dll` from the archive — prebuilt and unmodified.
3. Place it here as `apps/client/vendor/wintun/wintun.dll` and commit it.
4. Record the version and SHA256 below, so a future bump is a reviewable diff.

| field | value |
| --- | --- |
| version | _unrecorded — fill in when committing_ |
| sha256 | _unrecorded_ |
| source | https://www.wintun.net |
| licence | MIT (Wintun additionally carries its own redistribution terms — see `NOTICE`) |

Until step 3 is done, treat every Windows installer produced by this repository as
**non-functional for tunnelling**.
