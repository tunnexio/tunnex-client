# NAT-0: real-helper adapter boundary

Status: approved internal adapter slice implemented, 2026-09-06. No traffic proof claimed.
Client content tested: `0727e82` (subsequent commits are evidence only).
Companion laboratory bridge: tunnex `9982336`.

## Observed on the real helper

The actual development Electron executable used the built HelperConnection to
check the installed helper was down. It submitted a split-tunnel configuration
with fresh random fixture keys, address `10.250.0.1/32`, allowed destination
`10.250.0.2/32`, and gateway endpoint `127.0.0.1:51820`. No keys were printed or
persisted. Response: `ok=false`, `code=bad_endpoint`. Subsequent status was down.
This exercises the real caller-authenticated IPC boundary; it is not just a unit
test, and no tunnel or route was installed.

`apps/helper/config.go` intentionally rejects loopback gateway endpoints before
backend activation. The companion laboratory bridge uses a loopback endpoint.
Additionally, `apps/helper/wgcommon.go` selects `listen_port=0`; the existing
laboratory bridge pins its UDP socket to the exact known WireGuard source port.
The helper does not currently expose that port through its IPC contract.

Changing the imported endpoint to a hostname resolving to loopback, accepting
the first arbitrary UDP sender, or loosening generic endpoint validation would
bypass these ownership assumptions. None was attempted.

## Recommended next bounded implementation

Keep public/imported gateway endpoint validation unchanged. Integrate a
helper-owned transport adapter so local socket ownership and teardown remain
within the privileged backend. For the desktop, qualify an internal WireGuard
bind adapter; retain the connected per-peer UDP bridge for the Linux kernel
gateway. Compare these with the existing lab mechanism before selecting the
production transport, as required by NAT-0.

The qualification entrypoint must be isolated from normal packaged startup,
accept only private fixture signaling material, and exercise the real backend
without adding a caller-controlled localhost bypass. Production authenticated
CP signaling remains NAT-1; this experiment must not advertise CP policy or
automatic fallback completion. Run focused lifecycle/ownership tests and review
before restarting the live helper with adapter code.

This is a security-sensitive design fork, not an installer failure. Per the
story protocol it is held for disposition before changing helper contracts or
backend transport ownership. Installed development helper remains idle; original
restoration files remain at the path recorded in the desktop preflight ledger.

## Infrastructure check

AWS read-only identity verification returned account `735391218823`. Running
ap-south-1 instances are the existing BYODB CP and private database. No dedicated
relay/gateway host was verified and no cloud resource was changed. Do not use the
database VM as a relay or modify CP networking merely to force this proof.

## Approved adapter slice

User approved the helper-owned implementation. First slice adds an internal
WireGuard Bind for one fixed peer and a datagram-preserving session factory.
The factory transfers an already negotiated session, never a raw TCP stream;
Pion ICE remains responsible for TURN framing. Open creates a fresh session;
Close unblocks receive and cannot redirect an old receiver into a new session.
No direct-network fallback exists in this adapter. Wrong-peer endpoints fail.

macOS gains an unexported bind-construction seam used by package-local proof
tests. Normal NewBackend continues using the default WireGuard bind; no IPC,
environment, config file or imported profile can select the experimental bind.
The proof seam refuses full tunnels until relay-route exclusions are qualified.
Existing endpoint validation is unchanged. Session signaling and live Pion
wiring follow after adapter ownership tests and review; this slice alone is not
a live VPN result or a released transport.

## Implementation checkpoint

Implemented `apps/helper/internal/relaybind`: one fixed peer, owner-checked
endpoints, datagram session factory, generation-bound receive functions, bounded
close behavior under the Session contract, and no direct fallback. No new
dependencies or public IPC fields were added. macOS backend has the unexported
proof factory; standard construction remains unchanged. Early device failures
now close the device, including its bind, rather than only the TUN descriptor.

Passed native helper race tests and vet, repeated adapter race tests, and
Windows amd64/macOS amd64 CGO-disabled cross-builds. Two independent read-only
reviewers reported no actionable findings in this slice. The tests use synthetic
datagram sessions: real Pion framing, concurrency and closure are NOT qualified
by them. No updated binary was installed or host networking changed in this slice.

Next: attach negotiated Pion sessions to the package-local backend proof,
exercise actual encrypted traffic with a Linux peer, then perform the original
live cross-network/CP policy acceptance. Existing approval covers continuing
that bounded proof; no claim that the product NAT feature is finished.

## Pion/native-backend proof execution

Use a `natproof`-tagged test binary, never a production startup switch. Run
Pion ICE v4.4.2 in two processes: macOS uses the real darwinBackend/utun and
internal bind; an isolated Linux Docker fixture uses kernel WireGuard and a
connected local UDP bridge. Exchange synthetic signaling only through a private
scratch directory. Expose TURN TCP/TLS on localhost only, no UDP published.
This proves a real macOS-to-Linux-VM packet path, not an AWS/cross-network or
CP-policy walk. The cloud acceptance legs stay open.

The installed helper must be idle and stopped during the package-local backend
test; restart it afterward even on failure. Only /32 fixture routes may be used.
Use process-local fixture CA trust for TLS, never disable certificate checks or
install a CA into the Mac trust store. Retain stopped fixtures and redacted
evidence; private signaling and keys remain outside Git.
