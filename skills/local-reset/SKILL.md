---
name: local-reset
description: Tear down and rebuild the local dev environment from scratch in any repo — drops the local datastore volumes/data, brings the dev infrastructure back up, and re-applies the project's schema migrations from empty. Use this skill whenever the user wants to "reset", "wipe", "nuke", "start over", or "drop the DB" on their local setup, or when debugging a broken local state where the database, migration history, or seeded fixtures have drifted from a usable baseline. It learns the project's dev-infra and migration tooling (see the discovery contract) and handles the predictable papercuts that block a naive reset — a stale local env file missing keys a newer example added, and running migrations from a git worktree that doesn't carry the gitignored config the migration tool needs. It is the destructive back-half counterpart to `shipyard:preflight` (which is non-destructive). Skip this skill for production / staging resets — it is local only. If the user wants to KEEP their local data, use a single forward migration via `shipyard:preflight` instead.
---

# Local Reset

Wipe and rebuild the local dev stack. Use when the user says "drop the DB", "start over",
"reset local", "nuke everything", or when migrations / seed data are wedged badly enough
that fixing them piecemeal is slower than starting fresh. A naive `down -v && up -d &&
migrate` hits a couple of predictable blockers; this skill handles them.

## Step 0: Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**, focusing on
the **dev-infra** (Docker Compose / local services, env-file convention), the **migration
tool(s)** (and how to apply each chain), and any **gitignored runtime/config files** the
migration tool needs that a worktree won't have. If the project has a documented "reset
local" sequence or script, prefer driving that and interpreting its result.

If the project has **no containerized dev infra** and **no migrations**, there's nothing to
reset — say so and point the user at `shipyard:preflight` instead.

## When NOT to use

- The user wants to **keep** their local data → run a single forward migration via
  `shipyard:preflight`.
- The error is in **staging / prod** → this skill is local only.
- The user is reporting a **code bug** that happens to surface as a DB error → investigate
  the code first; reset only if state corruption is the actual cause.

## The flow

Run from anywhere; use absolute paths because the working directory may be a git worktree
rather than the main checkout.

### 1. Confirm scope with the user

Reset is destructive. Confirm before the destructive commands if the user hasn't already
said "yes do it". The destructive actions are dropping the datastore volumes/data and
re-applying migrations against the freshly-empty DB. Both are safe on local-only state,
**irreversible** if the user had unique local seed data.

### 2. Pre-flight: sync the local env file against its example

The #1 cause of reset failures: the example env file picks up new keys when new services
land, but the local env file (gitignored) still has the old set, so infra errors out before
doing anything. Diff the committed `*.env.example` against the local env file; append any
missing keys (example values are local non-secret fixtures, safe to copy verbatim).

### 3. Tear down

Bring the dev infra down **with its volumes** (the whole point — without dropping volumes,
the datastore persists and the migration-history-vs-schema mismatch you're fixing sticks
around). For Docker Compose:

```bash
cd "<infra dir>" && docker compose down -v
```

For a non-containerized DB, drop and recreate the local database/schema with the detected
client. Run from the directory the compose/env files live in so the right env is loaded.

### 4. Bring infra back up and wait for readiness

```bash
cd "<infra dir>" && docker compose up -d
# then wait for the datastore to accept connections (bounded loop)
```

Idempotent init sidecars (bucket creation, seed containers) re-run automatically — no
action needed.

### 5. Pre-flight: ensure the migration tool's config is present in the project being migrated

If the user is in a git worktree, gitignored config the migration tool reads (connection
strings, local app-settings) lives only in the main checkout. Without it the tool fails to
connect. Check the project being migrated and copy the file from the main checkout (located
via `git worktree list`) if missing. In the main checkout this is a no-op.

### 6. Apply all migration chains

Apply each chain the project has, in dependency order, with the detected tool. Some
projects have more than one chain (e.g. multiple ORM contexts / multiple databases) — apply
all of them. The first probe line per chain (the tool checking for a not-yet-existing
history table) is usually harmless; the chain reports success when it finishes.

### 7. Verify

Confirm the applied-migrations history matches the on-disk migrations for each chain, and
spot-check a known-recent table/column to be sure the schema actually landed (list tables /
describe one).

### 8. Hand back to the user

Tell them what's now live (containers up, schema applied, fresh DB), and remind them that
**startup seeders only run when the app boots** — so to get seeded reference data / dev
users, they need to run the app once (the detected run command) and, if the project uses
JIT user creation, sign in through the app.

## Failure modes and recovery

| Symptom | Cause | Fix |
|---|---|---|
| infra errors "var X is missing a value" | stale local env file | append missing keys from the example (step 2) |
| migration tool can't find a connection string | worktree missing gitignored config | copy it from the main checkout (step 5) |
| datastore never becomes ready | container didn't start or crashed | check `compose ps`, then its logs |
| "relation X already exists" after a reset | volumes weren't actually dropped (ran from the wrong dir / wrong env) | re-run the teardown from the infra dir with the right env file |

## Why this skill exists

The naive sequence (`down -v` → `up -d` → migrate) fails in many repos for two reasons that
are easy to forget and tedious to re-derive: the local env file drifts from its example
whenever a new service adds a required var, and migrations from a worktree need the
gitignored config present in *that* worktree. Keeping the recovery in a skill means the next
session doesn't rediscover either failure mode.
