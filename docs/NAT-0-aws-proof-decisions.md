# AWS cross-network proof

Approved continuation, 2026-09-06. Native baseline `a0c94dc`.
Verified AWS account `735391218823`, region ap-south-1. Existing CP/database
instances are not relay fixtures and their configuration must stay unchanged.

Create one dedicated t3.small proof host in the verified existing public subnet,
using the same Ubuntu image/key pair as the development CP. Scope a new security
group to this laptop's current public /32 for SSH and TURN TCP/TLS only. No UDP
ingress. Keep the instance/volume tagged and record IDs; stop only this new host
after the proof, retain disk/evidence rather than delete infrastructure.

Run a Linux kernel WireGuard fixture and pinned coturn there. Reuse the approved
native macOS backend proof and exchange private synthetic signaling over SSH.
Do not expose file signaling over HTTP or log credentials. This is explicit
fixture coordination, NOT production CP signaling. A process-local CA verifies
the host IP for TLS; never install it into the Keychain or skip validation.

This closes geographic/network separation for the packet proof only. The CP
currently has no relay session/candidate API and the GUI cannot select the
experimental adapter. CP-issued application policy and GUI-managed relay need
NAT-1/NAT-2 implementation; do not call this cloud fixture those features.

## Bounded feasibility continuation

User explicitly returned to feasibility before production implementation.
Keep NAT-1 isolated and idle. Add an opt-in proof-only mixed host/relay ICE
mode using the existing upstream nomination algorithm, not a new fallback
implementation. Reuse the dedicated AWS fixture, publish one fixed host UDP
port and temporarily allow it only from the laptop /32 for a direct positive
control. Remove that exact added rule to prove blocked-direct relay selection;
no other security group or infrastructure changes. Native encrypted traffic
must still pass after selection, not just ICE. Stop the dedicated host afterward.

Separately identify and use the real CP compiler/node firewall path for policy
qualification. A handwritten nftables allow list or helper AllowedIPs denial
does not close that requirement. Record any remaining blocker without extending
this spike into production signaling, GUI, database or lifecycle development.
