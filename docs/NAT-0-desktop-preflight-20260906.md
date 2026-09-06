# NAT-0 controlled desktop helper transition

Client content: `0727e82`, branch `codex/nat0-desktop-proof`, macOS ARM64.
User approved the controlled switch in-session. This is preflight evidence,
not relay traffic or CP policy acceptance.

- Saved and byte-compared the original helper and LaunchDaemon plist before
  mutation. Saved the original PF configuration. Restore files are retained in
  `/private/tmp/tunnex-nat0-helper-restore.SLxECP`, outside Git, with a restoration
  script. The original install had no `tunnelctl` driver.
- Initial administrator invocation could not read the Desktop repository
  (`Operation not permitted`). It failed before installer execution.
- Built helper and driver as the normal user with CGO and `-mod=readonly`.
  Generated the reviewed plist as the normal user and validated with plutil.
- After native macOS authentication, installed prebuilt artifacts via a scoped
  temporary script. The root process did not need repository access. This is a
  manual prebuilt walk, NOT a successful end-to-end run of the repository's
  development installer. That Desktop-access limitation remains to be addressed
  before claiming the installer itself works from this checkout.
- Stopped the existing LaunchDaemon before replacing the binary, then loaded
  the generated plist. Exactly one helper process was observed afterward.
- Native caller-auth indicator passed. `tunnelctl status` returned
  `ok: true`, `state: down`.
- The actual development Electron executable, in `ELECTRON_RUN_AS_NODE` mode,
  used the built client `HelperConnection` implementation to request status.
  It received `ok: true`, `state: down`. This checks real process-path caller
  authentication and IPC, not GUI Connect or a WireGuard handshake.
- Trust includes driver, packaged application and resolved dev Electron paths.
- Default route remained on `en0`; `/etc/pf.conf` remained byte-identical.
  No test tunnel, cloud mutation or relay allocation was created in this step.

Current state: development helper installed and idle; separate-profile Electron
development client remains running. Packaged caller trust is retained. Original
helper restoration has NOT been executed; run it only after the test tunnel is
down. It retains the newly installed dev-only driver instead of deleting it.

Remaining: real helper-to-Linux relay traffic, direct-UDP denial, authorized and
unauthorized resource proof, then restoration. No secret material is in this
evidence. The companion container proof does not satisfy these live legs.
