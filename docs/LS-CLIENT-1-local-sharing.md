# LS-CLIENT-1 — Local Sharing polish in the desktop client

Status: implementation on `story/ls-client-1` (local only, not pushed). Needs a
client release (0.1.14) once merged; see "Release" below.

Baseline: client v0.1.13 (`origin/main` a38bba7) against control plane v0.1.50.
The founder walked the Local Sharing screens live and reported eight problems.
Under the full-feature audit rule, every screen and state of the feature was then
reviewed in one pass: the new share form, My shares, Shared with me, the tray, the
bell, error states and the help panel. Every finding and decision is listed here.
Items are deferred only where a reason is given.

Terms follow the web console (platform LS-UX-1/2): **Local Sharing**, **share**,
**reviewers**, **publisher**, **Sharing updates**, and people shown as
**Name (email)**. Words such as "audience rule", "connector" and "grant" stay out
of the copy people see.

## What the platform API actually returns (checked on tunnex origin/main)

- `GET …/beam/audience` returns `users[{id,name,email}]` and `groups[{id,name}]`.
  - The caller is always included (`u.id=$2`), so publishers saw themselves as a
    reviewer option.
  - Groups carry no member count.
- `POST …/beam/shares` (Create) always adds a grant for the publisher
  (`append([]Grant{{"user", a.ID}}, in.Grants...)`). A share with one chosen
  reviewer therefore has **two** grants, which is why the card said
  "2 audience rules".
- `PUT …/grants` replaces the whole grant set, so the client must send the
  publisher's own grant back unchanged.
- `Share.publisher_email` (platform PR #137, LS-UX-2) is present on projections the
  caller may already read (publisher, manager, current reviewer). The desktop main
  process dropped it in `reviewerProjection`.
- `GET …/beam/policy` has no `reason` field. It reports `enabled`, `domain_ready`
  and `can_publish`.
- `GET …/beam/audience` fails with:
  - 403 `beam_publisher_denied` for a non-publisher;
  - 503 `beam_unavailable` when the feature is off or the domain setup is incomplete.
- `GET …/beam/shares?scope=active` returns shares in the starting, active or paused
  state. The extra `state=active&connectivity=online` filter that the desktop sent
  limits the list to live shares.
- Quota (`active_shares`/`max_shares`) counts the publisher's whole non-terminal
  inventory, whatever the list filters are.
- `publisher_email` ships in platform commit a06626ce, which is **after the
  v0.1.50 tag**. Against control plane v0.1.50 the client still shows the name
  alone ("Shared by Control Plane Admin"). "Name (email)" appears once the control
  plane runs a build that includes that commit (the next control plane release).
- There are no generated Local Sharing API types in this repository. The
  hand-written `beamtypes.ts` (main and renderer copies) are the contract.

## Founder observations

| # | Observation | Decision |
|---|---|---|
| 1 | "1 hours" in Link lifetime | One duration formatter for every duration the feature shows: lifetime options, extension options, countdowns and the policy maximum. It produces "1 minute", "15 minutes", "1 hour", "2 hours" and "1 hour 30 minutes". The policy maximum is always offered as a lifetime option, even when it is not one of the presets. |
| 2 | "2 audience rules" | The card shows **Reviewers: Alice, Developers group**, with up to three names and then "+N more". The publisher's own automatic grant is not counted. Selections that are not in the current reviewer list are counted in "+N more". With no reviewers it says "Only you can open it. Choose Access to add reviewers." |
| 3 | "Share created. Availability follows the connector status below." | Create resolves before the connection is live (the runtime returns `starting`), so claiming "live" would be false. The message is "Share is live. Reviewers can open it after signing in." when the returned share is already live. Otherwise it is "Share created. It shows Live in a few seconds; reviewers can open it after signing in." Each status now has a plain label and a one-line hint (see "My shares"). |
| 4 | "Who can review?" names only, with user/group tags; the publisher listed as a reviewer | Users are shown as **Name (email)**. The web console's `personLabel` rules apply: the email is not repeated when it equals the name, and the name is shown alone when the server sends no email. Groups are shown as **Developers group** (the word "group" is not added twice). The user/group tag is removed. **The publisher is hidden** rather than marked "(you)", because the server always grants the publisher and the checkbox did nothing. Main filters the caller out of the audience by `context.userId`. In the Access editor, the publisher's own grant stays in the saved set without a checkbox. Dropping it would remove the publisher's access and trigger a confusing "remove 1" confirmation. |
| 4a | Group member counts | **Platform follow-up**: `/audience` returns only `{id,name}` for groups. The client shows "Developers group" until the platform adds a `member_count`. |
| 5 | Create share disabled with no reason | A visible reason line, linked with `aria-describedby`, shows the first thing still missing: name the app, enter a valid port, enter a valid API path/port, check the app ("Check the app first", or "Your app didn't respond…" after a failed check), choose at least one reviewer. When no reviewers exist it says to ask an administrator. |
| 6 | Extend disabled with no reason | When the remaining room is under a minute, the card shows "Already at your organization's maximum lifetime of 1 hour." as visible text linked to the button. A tooltip is not used because disabled buttons do not reliably show one. |
| 7 | "PRIVATE APP ACCESS" eyebrow | Removed. It repeated the "Local Sharing" heading and suggested the separate App Access feature. The page keeps "Your local apps. A private link away." and "Works independently of your VPN". |
| 8 | "Shared by Control Plane Admin" | "Shared by Name (email)" in Shared with me and in the bell. `publisher_email` is added to the main-process reviewer projection allowlist and to both type copies. |

## Full-feature audit — further findings

### My shares was live-only (behaviour bug)

The desktop asked for `state=active&connectivity=online`, and the renderer then
removed everything that was not Live. As a result:

- a paused share disappeared, so **Pause was one-way** and Resume could not be reached;
- a share that lost its connection disappeared, so **Reconnect could not be reached**,
  although the help text told people to "choose Reconnect";
- a new share was invisible while it was connecting;
- the quota line could read "5 / 5 active shares" over an empty list, leaving
  nothing to Stop at the slot limit.

**Decision:** the publisher list asks for `scope=active` only (starting, active,
paused). Each status gets its own label, hint and actions:

| Status | Label | Hint | Actions |
|---|---|---|---|
| live | Live | — | Copy link, Open, Pause, Access, Extend, Stop |
| starting | Going live | Connecting. Reviewers can open it once it shows Live. | Copy link, Pause, Access, Extend, Stop |
| reconnecting | Reconnecting | The connection dropped. Tunnex is reconnecting; keep this computer online. | same |
| offline | Offline | This computer isn't serving the share. Choose Reconnect to serve reviewers again. | + Reconnect |
| app_unavailable | App not responding | Start your app on the same address and port. Your link and expiry stay the same. | same |
| paused | Paused | Reviewers can't open it until you resume it. | Copy link, Resume, Access, Extend, Stop |

- Open is offered only while the share is Live; otherwise the browser would show
  an error page.
- Ended and expired shares are still removed. A share leaves the list the moment
  its expiry passes, without waiting for a refresh, and the server never returns
  terminal shares under `scope=active`.
- This reverses the "removes all non-live cards" test from 2f54088. That test fixed
  a live-only rule this audit found harmful. The new test asserts that paused,
  offline and connecting cards appear with the right actions, and that
  stopped and expired cards do not.

**Shared with me stays live-only.** Reviewers can open only a live app. The same
route also feeds the bell and the revoked-access detection in
`BeamRuntime.notifications()`, and broadening it would change that security
signal. Its empty state now explains that apps appear while the person who shared
them is online.

### Error states (behaviour bug)

`BeamApi.view()` loaded the policy, audience and shares with `Promise.all`.
Because `/audience` fails for non-publishers (403) and when the feature is off or
setup is incomplete (503), the whole view failed. People then saw a generic error
alert instead of the policy message.

- **Decision:** `/audience` failures are tolerated only when the policy says this
  account cannot publish. The view then resolves with an empty reviewer list.
  When the account can publish, an audience failure is still an error, and access
  checks are unchanged.
- The policy message is built from the policy fields, because the server sends no
  `reason`:
  - feature off: "Local Sharing is turned off for your organization. An
    administrator can turn it on in the web console."
  - setup incomplete: "Local Sharing setup isn't finished on your server. An
    administrator needs to complete the sharing domain setup."
  - not a publisher: "Your account can open apps shared with you but can't share
    its own. Ask an administrator for publishing access."
- Slot limit: when `active_shares >= max_shares`, New share is disabled and the
  visible reason reads "You have 5 active shares, your organization's limit. Stop
  a share to create another." The inventory line reads "3 of 5 active shares".
- `beamError` matches exact server codes (`beam_quota_reached`,
  `beam_publisher_denied`, `beam_unavailable`) before the broad pattern fallbacks,
  so a code is never mistaken for a different failure.

### New share form

- App name: the placeholder "Checkout redesign" stays, and a missing name is now a
  stated reason.
- "Loopback address" is renamed **Local address**, with options
  "127.0.0.1 (IPv4)" and "::1 (IPv6)".
- Find local apps:
  - Results now appear inline next to the buttons ("Apps answered on 2 ports.
    Choose one."). Before, they appeared as a banner at the top of the page, away
    from the form.
  - The no-result message names the six ports it tried.
  - The scan is unchanged: on demand only, six ports, loopback HTTP.
- Port quick-pick: unchanged ("Port 5173").
- Frontend + API (optional): unchanged behaviour. An invalid API path or port is
  now a stated reason.
- Protocol: unchanged.
- Check app:
  - The result names the address it checked: "Your app responded on
    127.0.0.1:3000.", or "Nothing answered on 127.0.0.1:3000. Start your app or
    check the port and protocol."
  - Any change to the target still clears the result.
- The tray sentence stays: "Closing the window keeps active shares in the tray;
  Quit ends sharing."

### Share actions

- **Stop** uses the in-app confirmation dialog instead of the native
  `window.confirm`, worded like the web console: "Stop this share", "Keep sharing",
  "Confirm stop".
- Notices:
  - Pause: "Share paused. Reviewers can't open it until you resume it."
  - Resume: "Share resumed. It shows Live again in a few seconds."
  - Extend: "Share extended. It now ends at …"
  - Reviewer changes: "Reviewers updated." on both the direct and the confirmed path.
  - Copy link: "Link copied. Reviewers still need access and sign-in." (web console
    wording).
- The reviewer-removal dialog says "reviewer selections", "people" and "open
  sessions" with correct plurals, instead of "audience rule(s)/reviewer(s)".
- The Access editor states how many saved selections are outside the current
  reviewer list. Those selections are kept, not silently dropped.

### Bell

- The heading stays **Notifications**, because the bell also carries security and
  update notices.
- Share items appear under a **Sharing updates** label, using web console wording:
  "Ready to open" and "Shared by Name (email)".

- When review access is withdrawn, the notice used to say "App access revoked",
  which is the name of the separate App Access feature. It now reads
  "Shared app no longer available" with "Ask Name (email) or your administrator
  if you still need it." (`sharedAccessNotice`).

### Help panel ("App compatibility and sharing help")

- The paragraph about restarting was wrong: Quit stops shares on the server, so
  there is nothing to Reconnect after a normal restart. It now reads: "Quit ends
  sharing and stops your shares. If Tunnex loses its connection, choose Reconnect
  on the share. An ended share needs a new share."
- "WebSocket compression is unavailable in v1" is reworded to "isn't supported
  yet", dropping the "v1" jargon.

### Tray

- "Local Sharing, N active share(s)" was already pluralised correctly.
- "Quit (ends Local Sharing)" matches the in-app sentence. No change.

## Deferred, with reasons

- **Group member counts**: needs a platform field (`member_count` on `/audience`
  groups). This is a platform follow-up.
- **Offline or paused apps in Shared with me**: kept live-only for the security
  reason given above. Showing these would need a separate grant-scoped request
  that the revoked-access detection does not use. It belongs in a later story
  together with the platform.
- **A tray notice the first time the window is closed with active shares**: the
  in-app sentence already states the behaviour. A native notification is a new
  surface, outside this story's polish scope.

## Security

- No authority moves into the renderer:
  - The audience email and `publisher_email` are fields the server already returns
    to this caller. They are added to explicit main-process allowlists; no
    response is passed through wholesale.
  - The reviewer projection still strips the target, grants and connector fields.
- The self-filter only changes what is displayed. The server still adds and
  enforces the publisher's grant.
- Tolerating an audience failure happens only when the policy already denies
  publishing, so no publishing path opens.
- Grant writes still preview first and confirm removals, exactly as before.

## Release

User-visible client change, so it needs a desktop release. In this repo the
version bump usually lands inside the feature PR (#18, #21). This branch does
**not** bump, to avoid colliding with open PR #24 and to follow the
release-batching rule. A one-commit bump can be added on request. Before tagging
`v0.1.14`, bump both `package.json` and `apps/client/package.json` together
(`scripts/release-version.cjs` enforces equality). The helper is not touched.
