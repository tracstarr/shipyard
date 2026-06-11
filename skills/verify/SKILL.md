---
name: verify
description: Prove a change actually works at runtime — boot the real app and exercise the specific new surface live, then capture the evidence. This is the "only a full run counts as verification" gate: tests passing is not the same as the feature working. Use this skill whenever the user wants to "verify this works", "prove the feature works", "does it actually work", "run it and check", "exercise the endpoint live", "smoke test the change", "show me runtime evidence", or before declaring a change done. It complements an e2e/browser suite rather than duplicating it: e2e covers user-facing UI flows, so verify owns the gap e2e doesn't reach — backend-only and non-UI changes (a new endpoint with no UI yet, a job/cron, a background service, a service or migration side effect) — by booting the app against the local dev environment, hitting the new surface with a real request (authenticated where needed), and confirming the side effect actually landed (the row written, the message published, the log/trace fired). It learns how to boot, authenticate, and inspect from the project (see the discovery contract). It boots and tears down what it starts, is local-only (never touches staging/prod), and reports a pass/fail runtime-evidence verdict. `shipyard:deliver-feature` calls this as its runtime-evidence step; reach for it directly to live-check any change before shipping.
---

# Verify

Tests green ≠ feature works. A unit suite can pass while the endpoint 500s on a real
request, the job no-ops, or the row never gets written. This skill closes that gap: it
**boots the actual app and exercises the specific change live**, then captures the runtime
evidence — observed status, response payloads, the rows that actually changed, the
log/trace that actually fired.

## Step 0: Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**, focusing on:
**how to boot the app locally** (run command / entrypoint / dev server), **how to
authenticate a real request** (local IdP, dev token, seeded user, API key — read the auth
docs/config), **how to inspect the datastore** (DB client + connection), and **where logs
/ traces go**. If you can't determine one of these, say so and exercise what you can
(an unauthenticated health check still catches a startup crash).

## What it owns (and what it doesn't)

If the project has an e2e/browser suite, don't duplicate it.

| Change shape | Who verifies it |
|---|---|
| User-facing UI flow | the **e2e** suite (run / extend the relevant spec) |
| Backend endpoint (no UI yet) | **this skill** — boot + (token) + call + assert |
| Job / cron / scheduled task | **this skill** — trigger + confirm the run and its effect |
| Service / migration side effect | **this skill** — exercise + confirm the effect |
| Realtime / push event | a focused **e2e** spec (needs a client) |

The unique value here is the **backend-only, non-UI live exercise plus evidence capture**.

## Local only

This skill boots the local app against the local dev environment and queries the local
datastore. It **never** points at staging / prod and never mutates a production database.

## The flow

### 0. Preflight

The environment must be healthy first. Run **`shipyard:preflight`** in repair mode. If it
can't reach ready, stop — there's nothing to verify against.

### 1. Boot the app and take the baseline

Boot the app in the background using the detected run command (it stays up across the
exercise; tear it down in step 5). Wait for it to listen, then take the unauthenticated
baseline — this alone catches a startup crash or a broken dependency graph that tests can
miss (e.g. a health endpoint should return OK; a new route should appear in the app's
route list / generated API spec, if it has one). If the app won't come up, capture the
boot log and stop — that's a runtime failure regardless of test status.

### 2. Authenticate (for protected surfaces)

Obtain a real credential the way the project's docs describe — a local IdP token, a dev
bearer, a seeded user's session, an API key. Use a **full-access** identity for the happy
path; to verify authorization gating, repeat with an identity that should be **denied**
and assert the rejection (e.g. 403). If you can't mint a token headlessly, fall back to
whatever the e2e setup uses (it usually persists one).

### 3. Exercise the specific change

Pick the exercise by change shape and run the **real** action:

- **Endpoint** — call it with the credential; assert both the status *and* the payload
  shape (the named response, not an empty/`null` body where a payload is due; for an error
  path, the right 4xx, not a 500).
- **Job / cron** — trigger it the way an operator would (admin trigger, CLI, queue
  enqueue), then watch it to a terminal state.
- **Service / migration effect** — invoke the path that should produce the effect.
- **UI flow** — don't hand-roll it; run or extend the matching e2e spec, or drive it with
  the browser tools.

### 4. Confirm the side effect actually landed

This is the step that separates "it returned 200" from "it did the thing." Read the effect
back out of the **local** datastore (the detected DB client), or out of the queue / cache /
log it should have touched. Confirm the expected record exists with the expected values.
Where useful, capture observability evidence too — the trace, or the expected line in the
app log.

### 5. Tear down

Stop the app process you started in step 1. Leave shared dev infra up (preflight owns that
lifecycle, not this skill). Don't leave an orphaned process bound to the app's port.

### 6. Report the runtime evidence

Emit a compact verdict the caller can gate on:

```
RUNTIME EVIDENCE — <change> — PASS/FAIL
- Boot:     health OK; route/spec lists <surface>
- Exercise: <ACTION> → <status> (<shape>); denied-identity → <rejected status>
- Effect:   <store> +1 record (<id/keys>); <audit/log/trace> observed
VERDICT: feature works end-to-end at runtime.
```

If any leg fails, say exactly which and stop — a runtime FAIL is the top-priority finding
for the delivering change, ranked above any convention nit.

## Things this skill must not do

- **Never verify against staging / prod.** Local environment only.
- **Never report PASS without an observed effect.** A 200 with no confirmed write / log /
  trace is not evidence — chase the effect.
- **Never leave the app running.** Tear down what you booted.
- **Never duplicate an existing e2e spec.** If one covers the flow, run it.

## When this skill is the wrong tool

- **The change is a pure UI flow** with an e2e spec already — just run that.
- **The environment is broken** — `shipyard:preflight` (or `shipyard:local-reset` if state
  is corrupted) first.
- **You only want a standards/convention check**, not a live run — that's
  `shipyard:code-audit`.
