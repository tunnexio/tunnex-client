# Relay preparation clock-bound correction

User requested a product fix for v0.1.4 relay_helper_prepare_failed without
repeated customer shell diagnostics. TCP443 succeeds on the affected Mac;
its precise helper rejection remains unobserved.

Confirmed contract mismatch: connectivity snapshot validation permits a session
up to610 seconds ahead, while helper preparation refuses more than600 seconds.
Clamp the helper's preparation deadline to the earlier of the authoritative
session expiry and600 seconds from local time. This only shortens authorization;
never extend session expiry, change CP policy, or relax helper validation.
Retain closed-session cleanup and30-second forwarding authorization.

Surface only allowlisted helper rejection codes; never append raw errors,
TURN secrets or payloads. Direct-first connection orchestration is separate work
and is not silently added as an authentication fallback in this correction.
This correction is not a confirmed diagnosis of the reported Mac incident.
