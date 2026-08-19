# Code signing

Current state: **both installers are unsigned.** Windows shows a SmartScreen warning; macOS needs the
right-click → Open dance documented in `install.md`. This file is how each gets fixed, and what each
actually costs.

## Windows — free, via SignPath Foundation

SignPath sponsors free code-signing certificates for open-source projects. This repository qualifies
on the criteria that are objective: **public**, **OSI-approved licence** (Apache-2.0), and **built in
CI** from a workflow anyone can read.

### What to do

1. **Apply** at <https://signpath.org/apply> (the Foundation programme, not the paid product). Give
   the repository URL, the licence, and a short description of what the binary does — a VPN client
   with a privileged helper, so expect the review to be attentive rather than automatic.
2. **On approval** you get an organization ID, a project, and a signing policy. Create these in the
   SignPath console to match what the workflow already references, or change the workflow to match
   what you named them:
   - project slug: `tunnex-client`
   - signing policy slug: `release-signing`
3. **Add the credentials to this repository:**
   - secret `SIGNPATH_API_TOKEN` — Settings → Secrets and variables → Actions → Secrets
   - variable `SIGNPATH_ORGANIZATION_ID` — the same page, Variables tab
4. **Tag a release.** The signing step is gated on `SIGNPATH_API_TOKEN` being present, so it is inert
   until step 3 and active immediately after — no workflow edit on release day.

### What it does and does not buy

⚠ **The Foundation certificate is OV, not EV.** EV buys *immediate* SmartScreen reputation; OV accrues
it as downloads accumulate. So expect the warning to soften over time rather than vanish on the first
signed release. That is still a large improvement on unsigned, and it costs nothing.

⚠ **The workflow's signing step has never executed.** Its inputs are written from SignPath's
documentation, not from a run of this pipeline. Confirm the action version and input names against
their current docs before the first signed release, and treat that release as the test of the step.

## macOS — no free path

Notarization requires the **Apple Developer Program at $99/year**. There is no OSS exemption. Until
that is paid:

- `electron-builder.yml` sets `mac.identity: null` — ad-hoc signature only, deliberately
- the `.pkg` is not notarized, so Gatekeeper blocks first launch until the user explicitly allows it
- `install.md` documents the click-through

The privileged helper is ad-hoc signed separately in `stage-helper.sh` and re-signed by the `.pkg`
postinstall; that is what lets it execute on Apple Silicon at all, and is unrelated to notarization.

## What signing does not fix

⛔ **A signed installer that does not work is worse than an unsigned one** — it carries the
authority of a signature and fails anyway. Two guards exist for that reason:

- a tagged Windows build **fails** if `wintun.dll` is missing (`ci.yml`), because without it the
  helper cannot create the tun adapter and the client installs cleanly then cannot tunnel
- the release job prefers the signed binary but says explicitly in the log which one it published,
  so a silent signing failure cannot ship an unsigned artifact under a release that implies signing

## Alternatives considered

| option | cost | why not |
| --- | --- | --- |
| Azure Trusted Signing | ~$10/month | organisation accounts need ~3 years of verifiable legal history — blocks a newly formed entity |
| Certum Open Source | ~€30/year | cheap, not free; fine as a fallback if the SignPath application is declined |
| sigstore / cosign | free | supply-chain attestation, **not** Authenticode — does nothing for SmartScreen |
