# Beam local development

Status: Desktop Beam UI, typed IPC and app-lifetime native connector are implemented locally. Actual authenticated desktop lifecycle is qualified locally; browser/platform and operational acceptance remain separately tracked.

This `extra-feature` worktree starts from freshly pulled main `9b71d19`. The core worktree is `/private/tmp/tunnex-beam-plan`; its epic and authority contract are in `docs/EPIC-tunnex-beam.md` and `docs/BM-0-authority-contract.md`.

The connector in `apps/client/src/main/beamconnector.ts` uses native TLS/HTTP, holds identity only outside the renderer, pins one numeric loopback target and consumes an authenticated outbound CONNECT channel. It needs neither the VPN helper nor a VPN connection. The Beam drawer entry uses real account/org-scoped APIs through main. Main generates an RSA proof-of-possession CSR and keeps the issued connector key only in memory. HTTP and verified HTTPS loopback targets are supported. The app-lifetime connector keeps two idle outbound channels available while serving at most 32 active channels per share, checks origin readiness and reports heartbeats every two seconds. Closing the window keeps active shares in the tray; full quit retires local serving and attempts a bounded server stop. Restart lists shares offline until explicit reconnect/resume. Production credentials and publishing are never populated from the development fixture.

## Run the local transport demo

Use the repository's Node `24.21.0` and pnpm `10.34.5`. Local tool copies installed for this task are under `/private/tmp/tunnex-beam-tools/node_modules`.

Build the core development fixture from `/private/tmp/tunnex-beam-plan/packages/apptransport`:

```sh
go build -o /private/tmp/tunnex-beam-spike ./cmd/beam-spike
```

Run this command from the client worktree:

```sh
PATH=/private/tmp/tunnex-beam-tools/node_modules/node/bin:/private/tmp/tunnex-beam-tools/node_modules/.bin:$PATH \
BEAM_SPIKE_BIN=/private/tmp/tunnex-beam-spike \
pnpm --filter @tunnex/client dev:beam
```

Open the printed loopback dashboard URL. Its Open action launches a synthetic reviewer login and a real locally served HTML/SSE application through the connector. The Withdraw action disables fixture authority; current streams close and new requests are denied. Restart the fixture for a new authority/URL. Ctrl+C ends the task-owned processes. The demo also stops at its 20-minute absolute expiry.

All listeners bind loopback. Fixture certificates and synthetic tokens are written to a private temporary directory, not a renderer, tracked source or deployed control plane. The dashboard and synthetic sign-in are development fixtures, not a production access model.

## Verify the connector

```sh
PATH=/private/tmp/tunnex-beam-tools/node_modules/node/bin:/private/tmp/tunnex-beam-tools/node_modules/.bin:$PATH \
BEAM_SPIKE_BIN=/private/tmp/tunnex-beam-spike \
pnpm --filter @tunnex/client test:beam:integration
```

This integration command requires the real core fixture binary; it fails rather than silently skipping when it is absent. It proves TLS identity/tenant rejection, immutable target capture, HTTP/forms/cookies/redirect boundaries, SSE, WebSocket and bounded withdrawal on revoke and authority outage.

`pnpm --filter @tunnex/client test` includes all ordinary client test files, including the Beam input-boundary tests. Core-dependent integration programs live under `apps/client/dev` and run through the explicit integration command. Typecheck includes those dev files; the production main build includes only `src`.

No remote push, PR, release, cloud provisioning or deployed control-plane mutation is part of this local work.

## Run the real desktop in development

Build the actual renderer/main, then launch in a fresh task-owned profile:

```sh
pnpm --filter @tunnex/web build
pnpm --filter @tunnex/client build
BEAM_TEST_CP_URL=http://127.0.0.1:18283 pnpm --filter @tunnex/client dev:electron
```

This opens the real Electron application and keeps it running. It uses a separate temporary userData directory printed on startup and does not read the existing installed client's session. `BEAM_TEST_CP_URL` accepts a loopback base URL only. Optional `TUNNEX_DEV_USER_DATA` reuses a specific task-owned profile. The development launcher does not inject a credential. Sign in through the normal control-plane consent flow, then choose **Beam** in the navigation drawer. The runtime remains independent of the VPN/helper.

`pnpm --filter @tunnex/client test:beam:electron` runs actual Electron main/preload/renderer in a fresh profile, checks sandbox/context isolation, refuses unauthenticated publication, opens the real Beam UI, writes a screenshot to its task-owned profile and exits. This is a native runtime smoke; it does not establish authenticated sharing or packaged macOS/Windows acceptance.

Local validation: all 345 desktop tests and all 84 renderer test files passed (1,131 passing renderer cases and two declared expected-failure cases). Main/renderer typechecks and builds passed. Actual Electron main/preload/renderer smoke passed and the screenshot was visually inspected. Native HTTP/SSE/WebSocket concurrency and bounded withdrawal cases passed. The extracted renderer's former missing core fixtures are now small, committed-source contract snapshots with revision/path/SHA-256 provenance; refresh them deliberately with `apps/web/test/support/refresh-core-contracts.mjs`. Restoring those checks exposed eight Community API paths incorrectly marked as enterprise-only; the registry now matches the actual supported core contract.

Local macOS ARM64 and cross-built Windows x64 app directories were packaged from the final source. Beam ASAR module bytes and renderer entry bytes match the builds. Dashboard/dev/test fixture assets are excluded. Windows app/helper PE headers and the pinned vendored Wintun SHA-256 were verified; macOS helper staging was restored afterward. No installer was run, no service was installed, and no package was published. This is packaging proof, not native Windows execution or an installer qualification.

A separate test-owned Electron profile completed the actual local control plane's normal cookie login, consent endpoint, production PKCE callback/exchange and encrypted credential storage. After the explicit local publisher policy approval, real UI create/local check/reviewer selection, native admitted Live status, Copy/Open, Pause/Resume, explicit extension, impact preview/Cancel/Confirm/restore, window close/tray recreation, terminal Stop and tray Quit passed. Reopening the same encrypted profile confirmed both test shares stopped, terminal retry refused and production logout completed. The test program has no default credentials and does not bypass a policy grant; invoke it only for an explicitly configured local fixture:

```sh
BEAM_TEST_ACCOUNT_FILE=/path/to/private-mode0600-test-account.json \
BEAM_TEST_PHASE=login \
pnpm --filter @tunnex/client exec electron dev/beam-electron-authenticated.cjs
```

For an approved fixture, `BEAM_TEST_PHASE=publish` creates shares through the actual product UI, verifies local checks and selected audience, copy/open, real admitted connector channels, pause/resume/access/stop and tray lifetime, then quits through the production tray action. Its printed task profile and private `qualification.json` contain only redacted resource/test metadata. Reopen that same task profile with `BEAM_TEST_PHASE=reopen BEAM_TEST_PROFILE=/printed/task/profile` to verify clean quit committed terminal stops, restart remains offline, and production logout revokes its credential. These local qualification phases are never packaged and never seed a credential into production startup.

## Native transport and remaining qualification

### Desktop reviewer inventory

Beam has **My shares** and **Shared with me** tabs. The reviewer tab uses the existing user/group-granted `/shared` API, with server-side active/online filtering before bounded pagination. It shows only currently granted Live apps, publisher name and expiry. A server-adjusted timer removes expired cards between refreshes. Reviewer inventory does not enroll a connector or reconcile the publisher supervisor.

**Open in browser** sends only the share ID to main. Main rechecks current authority through `/shares/{id}`, verifies an exact HTTPS public hostname, and opens the system browser. Normal browser sign-in and Beam launch checks still apply; desktop credentials never enter the renderer or browser. Native reviewer DTOs project only display fields, excluding origin, grants and identity material.

The desktop header shows a compact **notification bell** beside the status dot across pages. Its unread badge combines unopened Live review apps with access, device and update notices. Clicking opens a small **Notifications** dropdown; closing it does not mark anything read. Opening from Home or Shared with me clears that app's notification after the OS accepts the browser launch; a launch failure or changed session does not mark it opened. Read markers persist in the local desktop profile as hashed server/user/org/share keys (bounded to 10,000), independent of credential rotation. The review inbox searches beyond already-read pages, refreshes while the desktop is open, and removes expiry between refreshes. Opening does not delete the share or remove it from Shared with me. These are local desktop notifications, not cross-device server read receipts.

Focused Home/Beam UI tests passed (87 cases across the four relevant files, including mixed notifications, acknowledgement, signed-out update visibility, failed download and failed review fetch); seven focused native reviewer/inbox regressions passed. Main build/typecheck and renderer build passed. Actual macOS Home displayed the AWS-granted Live app and cleared its notification on Open. After loading the compact final renderer, the read app stayed cleared and the bell dropdown showed no new reviews. Final native screenshot: `/private/tmp/beam-home-review-bell-20261007.png`. Automated native tests cover read persistence across runtime restart.

### Security and release notices

The native local inbox records confirmed managed-device revocation, enforced device-health access blocking, and withdrawal of a previously observed Beam reviewer grant. Missing unexpired grants are rechecked through the authority-scoped detail endpoint; temporary request failures, offline apps, paused shares and normal stopped/expired shares do not produce revocation alerts. Beam observations are in-memory, so automatic withdrawal detection applies to apps observed in the current runtime. Device notices use existing authoritative lifecycle callbacks; no cloud permission is changed by a notification.

Security notices are isolated by a hashed server/credential scope, hidden after sign-out or another credential/server selection, and stored as a bounded 100-event local inbox without credentials. **Mark as read** persists acknowledgement and repeated events do not restore the badge. Update notices are global and use the existing official desktop release service at startup and every six hours while the renderer is running. A definitive current-version result clears obsolete update notices; an unavailable service does not invent an update or discard a known notice. Development builds compare the Tunnex package version instead of the Electron executable version. **Download** opens the fixed official download page and acknowledges only after a successful browser launch; it does not install an update.

Current notification change validation: all 355 native desktop tests and 87 focused renderer tests passed, along with main build/typecheck and renderer build. Actual updated macOS dev app inspection confirmed the compact unified bell and empty dropdown with no events fabricated or real devices/access revoked. Native screenshot: `/private/tmp/beam-unified-notifications-20261007.png`. Security and release-event cases have automated fixture coverage; real cloud revocation and packaged Windows acceptance are not established by these checks.

Validation on 2026-10-07: all 349 desktop tests and 13 focused Beam UI tests passed; main and renderer builds passed. The actual updated macOS development app completed normal browser sign-in against `https://tunnex.app`, displayed the existing granted Live app and publisher, and opened its real local demo in Chrome. The grant-scoped foreign-publisher case, redaction, expiry and revoked-open refresh have automated coverage. This does not establish a separate Consumer account or packaged Windows acceptance. The original publishing development process was kept running. Native reviewer screenshot: `/private/tmp/beam-desktop-shared-review-20261007.png`.

`test:beam:websocket`, `test:beam:https`, `test:beam:backpressure` and `test:beam:vite` require an explicit built `BEAM_SPIKE_BIN`; none silently skips. Real native tests reject malformed, compressed and oversized frames/messages, including upgrade head bytes. The parser retains a 14-byte header scratch and streams payload under backpressure. WebSocket compression is unsupported in v1; limits are 1 MiB per frame, 16 MiB per data message and 1,024 fragments. Direct mutually verified TLS admission proves the connector rejects a declared HTTP body over 16 MiB without receiving the body or contacting the origin. The rejection explicitly closes its single-use connection. The public proxy applies an independent earlier body bound.

HTTPS readiness and both HTTP/WebSocket forwarding verify the selected numeric loopback address against certificate SANs while retaining the public HTTP Host. A trusted certificate for another DNS identity is refused. Native blocked-reader qualification confirms origin production plateaus, another request still serves, buffers remain bounded and withdrawal releases every pool reservation within five seconds.

Inventory uses bounded server pagination and search; a supervised share outside the displayed page is reconciled through its owner-scoped detail endpoint. Page/search changes never close another live share. Server quota is independent of visible page rows. App compatibility guidance covers local TLS, allowed hosts, HMR WebSocket URLs, cookies, redirects and transport limits. Owner audit history remains in the console.

The approved persistent demo also passed Pause, desktop refresh using normal encrypted credential restore and explicit UI Resume. The credential ciphertext remained identical; the server accepted the original source credential and preserved share ID, URL and expiry. The refreshed desktop shows Live with server quota while the VPN/helper is disconnected. The normal HTTPS browser login, nonce handoff and Continue flow rendered the demo origin HTML after local proxy trust configuration was corrected. The separate native fixtures establish SSE and Vite HMR behavior; the persistent demo serves static HTML. Both task-owned development processes remain running without automatic share creation or resurrection.

Remaining acceptance: native Windows runtime/installer and installed-client compatibility, real sleep/wake and full account/server/org-switch/outage matrix, supported customer-app/browser matrix and deployment upgrade/rollback. Local unsigned mac and Windows directories prove package contents, not those platform behaviors.
