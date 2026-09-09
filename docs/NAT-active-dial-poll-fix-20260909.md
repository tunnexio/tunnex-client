# Active relay dial polling: approved P1 correction

User approved the narrow correction and focused tests on 2026-09-09.

Persisted enrollment config can name gateway A while the fresh relay Connect
correctly resolves and negotiates B. Seeding the new poll monitor from persisted A
then makes unchanged B look like another move. The relay controller tears down its
single-use carrier and consumes/exceeds the bounded recovery allowance.

Keep an in-memory copy of the actual successfully connected key/endpoint in the
controller, clear it on down/failure, and seed the monitor from that copy. Matching
active relay key+endpoint updates are no-ops AFTER the existing owner assertion;
real key or endpoint changes retain owner-fenced fresh-session recovery. Never
persist the volatile dial over device identity or relax the recovery budget.

Regression: A→B recovery followed by repeated unchanged B monitor polls must keep
the B connection and not emit another recovery. Also verify a genuinely different
key/endpoint still recovers, and down clears the remembered active dial. No helper,
server, schema, cloud or installer changes are part of this correction.

Implemented: actual dial is published only after successful owned-Up; callers get
a copy, and down/failure clears it. Both monitor seeding and relay same-peer no-op
use that state. Existing ownership assertion runs before the no-op.

The same-peer regression failed before the fix with `relay_negotiation_changed`
and passed afterward. Controller+CP-adapter+monitor regression now proves A→B
reconnect, two unchanged B polls, preserved enrollment config, no extra recovery,
owner refusal and down cleanup over a mocked helper socket. Full client suite
321/321 PASS; typecheck/build PASS. Bounded independent re-review is clean.
This is not a new live two-gateway HA walk or native Windows qualification.

Post-commit verification of product `24b66e1`: renderer typecheck, the CI-scoped
`test/clientapp.test.tsx` suite (64/64), and renderer production build all PASS.
This is the renderer CI scope, not a claim that every renderer test was run.
