# Native relay proof runner (development only)

Run from this repository on macOS ARM64 with Docker, Go, Node, OpenSSL and the
idle development helper installed. Requires the private Linux fixture image
`tunnex-nat0-kernel:20260906a` built by the companion tunnex NAT-0 experiment.
This is not a customer installation command or a supported relay feature.

```sh
bash scripts/nat0-native-run.sh tcp
bash scripts/nat0-native-run.sh tls
```

Each run asks macOS for administrator authentication to create the test utun.
The installed helper must report down. The root runner refuses existing 10/8
routes/addresses, stops that helper, invokes only the prebuilt package-local
test, and restarts the helper through an exit trap. Normal package startup does
not select this transport. No new public IPC or profile setting is exposed.

The macOS endpoint uses the actual darwinBackend with an internal Pion-backed
WireGuard bind. A separate Linux process uses kernel WireGuard and a connected
UDP bridge. A fresh coturn fixture is reachable only through localhost TCP
ports 13478/15349; no UDP port is published. The dedicated Docker bridge allows
container egress. This is not a cross-network direct-UDP-blocking experiment.

Only test /32 routes are installed. Both private destinations first succeed;
then one is cryptokey-denied while its OS route stays installed to prevent a
cleartext default-route fallback. Handler counts and the allowed destination's
liveness are checked. Closing the relay must fail a new request. TLS validates
a process-local CA; a separate unprivileged process rejects the untrusted CA
with exact x509 classification and zero candidates. Keychain trust is untouched.

Private artifacts stay in the printed mode-0700 scratch directory; generated
signaling is mode 0600 and owned by that directory's owner for Docker Desktop
sharing. No secrets should be copied into Git or issue comments. Containers,
networks and scratch directories are retained, not cleaned automatically.

Limitations: server timeout includes time spent in the admin dialog. A timeout
is a failure, never a pass; rerun a fresh fixture after slow authentication.
An abrupt machine/process termination can require the normal helper self-heal.
The runner proves native backend traffic, not Electron GUI enrollment, CP
authorization, automatic fallback, Windows, or AWS acceptance. See the dated
ledger for actual results. Full exact-head PR gates remain required before merge.
