# Managed NAT Connect integration — development checkpoint

## Latest: measured path status and bounded transport recovery

**Live follow-up completed:** user installed helper (signed SHA256
`9c7c39ea8340438e2c7880d051b15a78694de55c9dbe1e2e090409b61f6f2345`), bundle synced.
Real TURN restart recovered native Relay/HTTP with generation15→16 on corrected
controller `ef27fd92002a5d8473004e0a31747f217822503aa4c8f69780d8232191a36b5b`.
An earlier failed run exposed CP HTTP500 being omitted from transient handling;
500 now follows the same existing-lease-only retry as502/503/504. 403 still refuses.
Focused500/403 regression and full309/309 client tests PASS. Final outage run
exited0, helper down, temporary bearer revoked. This supersedes installation-
pending text below, not the still-outstanding GUI/full-platform/review requirements.
Detailed failed attempts and final evidence are in server NAT-product-aws ledger.

Local-only source adds helper `connection_path` and a line in the existing client
connection panel. Relay classification uses the selected ICE pair; a peer-reflexive
pair without a known relay is `unknown`, not falsely advertised as direct. Older
helpers report "Path unavailable". Closed relay state does not retain a direct label.

Helper owner loss/failed authorization lease can request the same one-attempt
managed recovery as changed offers. The attempt consumes the shared recovery
budget and reuses owner-fenced normal Connect. CP 403 is not a recovery trigger.
Neither path bypasses current CP authorization or extends a failed helper lease.

Local results: client 308/308; focused renderer 66/66; helper race suite and path
classification tests; client and renderer builds PASS. A privileged helper update
is required for live path-label qualification; the running helper has not been
replaced. The prepared candidate is SHA256
`98fc9305bf8b0162ddab89ef3eee41430f175f88d0fc336a7b04efaf795ca547` (pre-signing).
macOS sudo requires user authentication. Stop the GUI tunnel before installing;
the private installer refuses while Up, retains a root-owned rollback snapshot,
verifies candidate/previous hashes and restores the old helper on install failure.
Live interruption/recovery, GUI visual inspection and final review remain owed.

## Latest local renewal slice

**Completed live result:** native real-clock rollover PASS. CP generation 9
(expiry `2026-09-09T07:28:00.286677Z`) automatically replaced by generation 10
(expiry `2026-09-09T07:37:33.335939Z`); HTTP passed after the original expiry plus
20 seconds. Driver exited 0, helper down, temporary bearer revoked. At least 108
periodic samples passed; sampling pauses during break-before-make, so this is not
seamless/zero-loss proof. No DB expiry edits, manual reconnect or policy repair.
Driver uses actual controller and lifecycle queue, not full GUI/IPC orchestration.
See the server's `docs/NAT-product-aws-20260909.md` for artifact hashes and scope.
This completed result supersedes the in-progress paragraphs below.

Continuation: `ManagedLifecycleCoordinator.serialForLease` is now the production
Connect queue entry. Five new executable tests cover queued disconnect/logout/
server replacement, repeated generation fencing and bounded failed operations.
The existing AST wiring guard checks this exact entry and captured recovery lease;
its previous callback-position assumption was updated, not skipped.

Current local results: client suite 307/307 PASS; typecheck/build PASS; helper
race tests, vet, NAT-tagged suite and Windows amd64/macOS amd64 builds PASS;
renderer build and four dev-plist trust tests PASS. Linux node's complete
`make test-node` also PASS in the server lane. Cross-compilation is not Windows
runtime qualification. The two known renderer census fixtures still reference
server-only files; a full renderer test pass is not claimed.

Live renewal proof is running against the unchanged AWS CP and installed helper,
using the real ten-minute lifetime. Driver uses production TunnelController and
the same owner-fenced lifecycle queue, but does not invoke Electron's full IPC/
enrollment flow. Record its completed result separately before counting acceptance.

2026-09-09: decision `NAT-session-renewal-decisions.md` committed as `450ad83`.
Uncommitted client code now requests one owner-fenced managed reconnect after an
authorized heartbeat enters the final 60 seconds of its immutable session.
Planned renewal does not consume the changed-offer recovery budget. Refused reads
do not request renewal, and terminal generations do not receive a new helper lease.
This is break-before-make, not seamless transport migration.

Focused framed-helper tests: 9/9 PASS (changed offer, planned renewal, refusal).
Full client suite: 302/302 PASS; typecheck, build and diff whitespace check PASS.
These tests prove the controller's renewal signal, not successful end-to-end
managed reconnect. The running GUI has not been restarted to load this slice.
Next: test queued renewal ownership cancellation and repeated generations, then
load the candidate for a real ten-minute rollover; do not claim that live proof
from the mocked 45-second session tests.

Branch: `codex/nat0-desktop-proof`. Current changes are uncommitted and unreviewed.
Do not interpret this as a release or live-acceptance record.

## Implemented

- Main-process connectivity API: fixed HTTPS origin and captured bearer;
  redirects refused; device/key/gateway/session binding; bounded mailbox bodies;
  no error-body or bearer forwarding. Initial gateway UUID is CP-authoritative,
  while its WG key must match the already-owned tunnel config.
- Existing managed Connect creates a session only for an enabled relay profile.
  Old CP profile 404 and disabled profiles preserve direct behavior. Imported
  profiles do not use this path. HTTP-only legacy origins remain direct-only.
- Helper negotiation is scoped to its authenticated IPC connection. The helper
  gets scoped TURN credentials, not a CP bearer. Other connections cannot consume
  the prepared offer or renew its session. Connection close releases allocations.
- macOS split-tunnel backend uses the internal encrypted ICE datagram bind;
  the WireGuard private/public keys and normal routing configuration remain the
  authority. Windows/full-tunnel requests refuse this relay path explicitly.
- Main heartbeat reauthorizes through CP before renewing the helper's 30-second
  forwarding lease. CP request failure closes the relay owner connection. Local
  status-only heartbeat cannot renew relay authorization.

## Local results

- TypeScript typecheck: PASS.
- Full client suite: 298 tests PASS, zero skipped on this Mac.
- Includes normal Connect orchestration with a framed mock helper socket and
  mocked CP. Verifies CP bearer absence from helper IPC. This is NOT live ICE.
- Full helper suite with race detector: PASS.
- Envelope isolation, missing connection preparation, wrong session renewal,
  closed-session revival refusal: PASS.

## Still required

- Real Mac helper + AWS current candidate test; native installed helper and cloud
  candidate were not replaced by these code/test operations.
- Candidate route exclusions and relay address safety under DNS changes.
- Long-lived generation renewal/reconnect: current session expires within ten
  minutes; automatic lifecycle renewal is not implemented or claimed here.
- Direct/relay status UI, release capability/version qualification, independent
  review, both-platform gates and final required CI.

Counterpart server/node edits are in `codex/nat1-session-contract` in the NAT-1
worktree. Existing CP remains at https://cp.13.126.184.110.sslip.io, running the
earlier Neon-backed build, not this candidate.

## Recovery correction after the GUI walk (2026-09-09)

The preceding live-install-pending text is historical. The helper and AWS
candidate were installed and an initial native allow/deny walk passed (server
evidence commit `3c94b7e`). The GUI walk then exposed a sustained-connection gap:
gateway sequence advanced to 9 while device sequence stayed 1, with the client's
old handshake and traffic counters frozen. Routes and the new device's allow
policy were present. CP requests were also slow/timeouting; the first carrier's
termination reason was not logged, so lease expiry is suspected, not proven.

Client changes now reject changed established offer sequences/payloads before
renewing helper authorization, close the old owner, and preserve Failed over a
surviving interface's Up response. Managed IPC schedules at most one ordinary
Connect retry per explicit user Connect; the captured lease is checked inside
the lifecycle FIFO, preventing stale recovery after logout/disconnect. A fresh
Connect creates a new session rather than reusing the broken ICE transport.

Local build and full client suite: 300 tests passed, zero skipped. New regression
checks exercise changed offers over a framed mock helper and prove no renewal
plus truthful Failed even if the mock helper still reports Up. These tests do
not constitute live automatic-recovery acceptance. Initial sustained AWS retest
failed on a CP request timeout before reaching traffic assertions. The second
attempt also failed on `control_plane_request_timeout`; its cleanup reported
tunnel down and bearer revoked. Sustained live traffic and automatic recovery
are NOT proven. The updated dev app must be relaunched to load the build.
