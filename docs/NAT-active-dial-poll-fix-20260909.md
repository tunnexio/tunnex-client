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
