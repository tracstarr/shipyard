---
name: preflight
description: Prove the local dev environment is healthy before starting work — the lightweight, NON-destructive "initialization phase" for an agent (or human) session, in any repo. It learns the project's setup (see the discovery contract) and then checks, and with repair mode fixes, the things that silently block a session: missing dependencies (a fresh clone or git worktree that didn't inherit installed packages), gitignored runtime/config files a worktree doesn't carry, a stale local env file missing keys a newer example added, dev infrastructure (Docker Compose / services) being down, a database not accepting connections, and pending schema migrations. Prefer the project's own setup/preflight script when it has one; otherwise derive the steps from what's detected. Use this skill whenever the user wants to "check my environment", "is my local set up", "get this worktree ready", "preflight", "why won't the app/DB/frontend start", "set up this repo", or before booting the app, running migrations, regenerating a client, or starting a dev server from a fresh checkout. It is the front-half counterpart to `shipyard:local-reset`: preflight is non-destructive (brings infra UP, installs deps, applies forward-only migrations — it NEVER drops a volume or wipes data), whereas local-reset tears the stack down and rebuilds. Reach for local-reset instead only when state is corrupted badly enough that a clean wipe is faster than a repair. Other Shipyard skills (`deliver-feature`, `code-audit`, `verify`) call this at their start.
---

# Preflight

Initialization is its own phase. Before any real work in a checkout — especially a fresh
clone or a git worktree — prove the harness is healthy from a known-good baseline.

## Step 0: Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**, focusing on
the **dev-infra**, **migrations**, **dependency**, and **runtime-files** facts. The key
question: **does the project ship its own setup/preflight script?** (`scripts/preflight.sh`,
`bin/setup`, `make dev`, `just setup`, a documented "local setup" sequence). If it does,
**prefer it** — drive that script and interpret its result, rather than re-deriving the
steps. This skill only hand-rolls the checks when the project has none.

## Non-destructive by design

This is the opposite end of `shipyard:local-reset`:

| | preflight | local-reset |
|---|---|---|
| Direction | brings the stack **up** to ready | tears the stack **down**, rebuilds |
| Data | never dropped | **drops** volumes / wipes the DB |
| Heaviest action | start infra, install deps, forward-only migrate | `compose down -v` / drop schema |
| When | start of (almost) every session | only when local state is corrupted |

Preflight never drops a volume or deletes data. If it finds migration drift it can't
reconcile forward (the DB is on a migration that no longer exists on the branch), *that*
is when to fall back to `shipyard:local-reset`.

## What it checks (run check-only first; repair only when asked or in repair mode)

Adapt each check to what discovery found; skip the ones the project doesn't have.

1. **Runtime / config files.** Gitignored files the app needs that a worktree or fresh
   clone won't have (local env files, dev app-settings, credentials for local services).
   In repair mode, seed them from the committed `*.example` (or copy from the main
   checkout, located via `git worktree list`). Missing these is the classic "connection
   string not initialized" / "config not found" startup crash.
2. **Env-file freshness.** Every key in a committed `*.env.example` is present in the local
   env file. In repair mode, append missing keys from the example (example values are
   local non-secret fixtures). This is the papercut where a new service adds a required var
   that older local env files don't have, so the stack errors before doing anything.
3. **Dependencies.** The package manager's install marker exists (`node_modules`,
   restored NuGet, a built `target/`, a populated venv, vendored modules). Worktrees and
   fresh clones don't share these. In repair mode, run the deterministic install
   (`npm ci`, `dotnet restore`, `cargo fetch`, `pip install -r`, `bundle install`, …) —
   prefer the lockfile-respecting form so the tree stays clean.
4. **Dev infrastructure.** If the project has Docker Compose / local services, the
   containers are running. In repair mode, bring them up (`docker compose up -d`).
5. **Service reachability.** The DB (and any other required service) accepts connections —
   wait a bounded interval for a freshly-started container before failing.
6. **Migrations.** For each migration chain the project has, the newest on-disk migration
   appears in the applied-migrations history. In repair mode, apply pending **forward-only**
   migrations with the detected tool. Never roll back or drop here.
7. **Smoke (optional, "and it actually builds").** Run the detected build + the fast
   (unit) tests + typecheck. Slow; reserve it for "ready" needing to mean "compiles," or
   for diagnosing flakiness that smells like a toolchain problem.

## How to drive it

1. **Default to repair mode for an interactive "get me ready" request.** The repairs are
   non-destructive and idempotent; running them on an already-healthy environment is a
   no-op that reports ready.
2. **Use check-only when the caller must not mutate the workspace** — e.g. a report-only
   audit, or CI that needs the tree pristine. Surface the failures and stop; don't proceed
   as if the environment were healthy.
3. **Add the smoke pass when "ready" needs to mean "and it builds"** — before a long
   autonomous run, or when chasing toolchain flakiness. Skip it for a quick check.
4. **Read the result, not just the exit code.** Pending migrations in check-only mode are
   a warning, not a hard block; repair mode (or `local-reset`) clears them.

## Interpreting failures

| Symptom | Likely cause | Fix |
|---|---|---|
| runtime/config file missing | fresh clone / worktree didn't inherit gitignored files | repair copies from the main checkout or seeds from `*.example` |
| env file missing key(s) | a new service added a required var to the example | repair appends them |
| deps missing | fresh clone / worktree | repair runs the deterministic install |
| infra not running | dev services down | repair brings the stack up |
| service up but not accepting | container still starting or wedged | check its logs; if wedged → `shipyard:local-reset` |
| migration apply failed | drift the forward update can't reconcile | fall back to `shipyard:local-reset` |
| install / build / test failed | a real toolchain or code problem | read the captured log; this is not an env papercut |

## When this skill is the wrong tool

- **State is corrupted, not just unconfigured** (migration-history vs schema mismatch,
  wedged service) → `shipyard:local-reset`.
- **The user wants a full from-scratch wipe/rebuild** → `shipyard:local-reset`.
- **The problem is in a deployed/staging/prod environment** → this is local only.
- **The user is mid-feature and just wants the code reviewed** → environment is presumably
  up; go to `shipyard:code-audit` (which itself preflights in check-only mode).
