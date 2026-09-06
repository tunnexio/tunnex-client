# Native Pion/backend walk — 2026-09-06

Status: IN PROGRESS, not NAT-0 acceptance complete. Baseline internal adapter
`e809a70`; proof execution decision `6a0bd97`. No cloud changes.

Uses Pion ICE v4.4.2 and local Linux ARM64 fixture image
`sha256:ee195b2ab2c7826b839a59ef9424f2a60ca67c8d94bed8e078f939090cdae890`,
derived from pinned coturn 4.17.2-r0. macOS test invokes the actual darwinBackend
with its private bind seam; Linux test invokes kernel WireGuard. This does not
exercise the Electron GUI Connect flow, CP policy, or an AWS gateway.

## Review and preflight

Two reviewers flagged possible destruction of existing non-utun fixture routes.
Under the user's explicit continue-without-waiting direction, the required
preservation fix was folded: reject all explicit 10/8 routes and assigned 10/8
addresses before privileged mutation. Both reviewers closed it. No default
routes or DNS settings are requested by the proof.

## Attempts retained

| Fixture | Observation |
| --- | --- |
| `tunnex-native-pion-20260906T132438-44664` | Native TURN gathering failed; no tunnel |
| `tunnex-native-pion-20260906T132615-44803` | Classified TCP connection refusal. Docker internal network had empty actual port mappings despite requested host bindings. Diagnostics confirmed container listeners were up. |
| `tunnex-native-pion-20260906T132823-44983` | Host TCP preflight passed on dedicated normal bridge. Docker Desktop could not read root-owned mode-0600 client signaling file; signaling/ICE timed out. No tunnel. |
| `tunnex-native-pion-20260906T133033-45247` | Ownership fix allowed ICE connection. Backend failed during IpcSet: setting listen_port=0 after macOS TUN-up re-opened the single-use negotiated session. Cleanup restored idle helper. |

Fixtures/networks retained, stopped after each attempt. Installed helper restart
is in the root runner exit trap. The dedicated bridge permits container egress;
only localhost TCP ports are published, no UDP ports. This is NOT an egress-blocked
network or a deliberate direct-UDP firewall-denial proof.

## Runtime folds

- Use dedicated normal bridge with localhost TCP publications; check host TCP
  reachability before authorization. Independent review found no new issue.
- Root signaling files retain mode 0600 but take their private directory owner's
  UID/GID before atomic publication, permitting Docker Desktop file sharing.
  Independent review found no new issue. No secrets are included in this ledger.
- Internal proof config omits only listen_port=0 because no UDP listener exists;
  normal direct configuration remains unchanged. Focused regression and race
  tests passed; independent review found no issue. Live retry pending.

Native race tests and vet with `natproof` compile the path but skip actual
traffic without explicit fixture variables. Linux ARM64 proof binary compiled.
Do not count those skips as live passes. Exact-head remote CI has not run.
