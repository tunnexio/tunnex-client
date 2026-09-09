# Managed relay session renewal

Development slice, 2026-09-09. Implements the existing NAT lifecycle requirement;
not live acceptance or a production-ready claim.

- The CP's ten-minute session remains immutable. Never extend its expiry locally
  or revive an expired/closed generation.
- On an authorized heartbeat within 60 seconds of expiry, close the current
  carrier and request one ordinary managed Connect through the existing FIFO.
  This is break-before-make; brief interruption is expected, not seamless handover.
- Reuse captured owner fencing. Disconnect, logout and profile replacement that
  invalidate that owner prevent a queued renewal from running.
- Planned renewal does not consume the one-attempt broken-offer recovery budget.
  A failed renewal is terminal; no uncontrolled retry loop. Each successful new
  session can independently reach its own renewal boundary.
- Authorization refusal is not a renewal trigger. Read and validate the current
  CP response before requesting early renewal; fresh Connect rechecks ownership
  and current authorization. CP outages never extend the helper's 30-second lease.
- Tests must distinguish scheduled renewal, changed offers and refused reads.
  A real run across the ten-minute boundary remains required before acceptance.
