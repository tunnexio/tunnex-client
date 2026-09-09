# Windows split-tunnel relay integration

2026-09-09: implementation slice of the existing NAT-2 cross-platform scope.

- Reuse the macOS authenticated IPC preparation, scoped credentials, immutable
  session binding, Pion endpoint and WireGuard userspace bind on Windows.
- Preserve the existing Windows named-pipe authentication and managed Connect
  lifecycle. Do not introduce a second enrollment or recovery mechanism.
- Negotiate before adapter/firewall mutation. Transfer bind ownership to the
  WireGuard device; close it on adapter creation failure. Do not emit a UDP
  listen-port update for the single-use negotiated carrier.
- Full-tunnel relay remains explicitly refused before host changes. This slice
  does not qualify relay route exclusions, WFP carve-outs or full-tunnel MTU.
- Report the actual selected path in existing helper status, clearing relay
  state on both normal and fail-closed teardown. Ordinary direct mode is unchanged.
- Unit/race tests and Windows cross-compilation are substitutes, not native
  acceptance. Before cross-platform beta, run the normal Windows named-pipe
  client against Linux/coturn: allow/deny traffic, renewal, relay outage,
  network switch, helper restart and cleanup. Do not infer this from Mac evidence.

No installed helper replacement, cloud mutation, release or merge in this slice.
