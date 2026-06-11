---
name: handoff
description: Leave a clean, resumable state when PAUSING work mid-feature — the pause-endgame counterpart to `shipyard:ship-pr`'s ship-endgame. Use this skill whenever the user wants to "wrap up", "stop here", "leave it clean", "hand this off", "pick this up later", "save my place", "I'm done for now", "end the session", or otherwise stop work that isn't ready to ship. It captures what's done / in-progress / next / blocked, ensures a RESUMABLE git state (never leaves uncommitted work in a worktree, where it can be lost — commits a marked WIP or confirms a clean tree), scans for debug cruft introduced this session, confirms the standard startup path still works (via `shipyard:preflight`), and records the handoff in a DURABLE place that survives across machines/worktrees/sessions — a comment on the tracking issue (durable cross-session tracking belongs in the issue tracker, never a checked-in HANDOFF.md/PLAN.md), optionally a project memory for AI continuity. It never pushes, opens, or merges a PR (that's `shipyard:ship-pr` / a human call) and never checks in a plan file. Reach for `shipyard:ship-pr` instead when the work is actually ready to ship; reach for this when you're stopping partway.
---

# Handoff

The mirror image of `shipyard:ship-pr`. Ship-PR is for "I'm done — land it." Handoff is for
"I'm stopping partway — leave it so the next session (me, a teammate, or a fresh agent)
resumes in seconds, not minutes." A session that ends in a messy, half-staged, undocumented
state taxes every session after it; this skill prevents that.

## Step 0: Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**, focusing on
the **issue tracker / PR tool** (where the durable handoff goes), the **build/test
commands** (to record their state), and whether the project has a **setup/preflight path**
(to confirm startup still works).

## When NOT to use

- **The work is ready to ship** → `shipyard:ship-pr`.
- **A trivial one-off** that's already committed and needs no follow-up.
- **The environment is broken** (you're stopping because local is wedged) → note that in the
  handoff and point the next session at `shipyard:preflight` / `shipyard:local-reset`.

## Where the handoff lives (and where it must NOT)

Durable cross-session tracking goes in a **tracking issue**, never a checked-in
`HANDOFF.md` / `PLAN.md` / `NOTES.md`.

| Layer | Carries | Survives |
|---|---|---|
| **Tracking issue comment** (primary) | the prose state: done / next / blocked, branch, last SHA | across machines, worktrees, people |
| **WIP commit** (code) | the actual in-progress code | the branch (and any push) |
| **Project memory** (optional) | a one-line "feature X in progress" for AI continuity | future agent sessions |

Never write a handoff into a tracked file in the repo. If there's no issue yet and the work
is worth resuming, create one first. (If the project has no issue tracker, record the
handoff where its durable cross-session state lives, and say where.)

## The flow

### 0. Pre-flight

```bash
git rev-parse --abbrev-ref HEAD     # branch (must be a feature branch, not the base)
git status --porcelain              # working-tree state
gh issue list --state open --search "<feature>" 2>/dev/null   # find the tracking issue
```

If on the base branch, stop — handoff is for feature work on a feature branch.

### 1. Capture the state

Write four short lists, grounded in what actually happened this session:

- **Done** — completed, verified sub-tasks (with how they were verified).
- **In progress** — what's half-built and its *current state* (e.g. "endpoint added, returns
  200; response not yet wired to the UI").
- **Next** — the single clear next action, then the ones after.
- **Blocked / unverified** — anything red, flaky, stubbed, or unconfirmed — **especially a
  failing build or test**. Never hide a red state; the next session inherits it.

### 2. Record build / test / startup state

The next session must not discover breakage by surprise. Capture:

- Build: the detected build command — green, or the first error.
- Tests: last-known state of the fast suite, and whether you ran it this session.
- Startup path: does the stack still come up clean (`shipyard:preflight`)? If not, that's
  the top "blocked" item.

State the truth: "build red — `Foo.cs:42` CS8602" is a *good* handoff; "looks fine" is not.

### 3. Resumable git state — never lose uncommitted work

A worktree can be pruned; uncommitted changes in it are not safe. End on one of two states,
never a dirty tree:

- **Already clean** (everything committed) — nothing to do.
- **Work in progress** — make a marked WIP commit so nothing is lost:

  ```bash
  git add -A
  git commit -m "wip(<area>): <one-line current state> — see #<issue>"
  ```

  Use a `wip:`-prefixed message so it's obviously not a finished commit (squash/amend when
  work resumes). Don't fold in unrelated changes; surface them. Don't push unless the user asks.

### 4. Clear the cruft

Scan what you touched this session for leftovers that would mislead the next reader, and
remove (or explicitly flag) them: stray debug prints / `console.log` / `debugger`;
commented-out blocks left "just in case"; a focused/`.only`/`skip` left on a test; temp
files or scratch scripts outside the repo's tracked surfaces. A real `// TODO` you intend to
leave is fine — but put it in the **Next** list too, so it's tracked, not buried.

### 5. Write the durable handoff

Post the state as a comment on the tracking issue:

```bash
gh issue comment <N> --body "$(cat <<'EOF'
## Handoff — <date> — branch `<branch>` @ `<short-sha>`

**Done**
- …

**In progress**
- …

**Next**
- … (start here)

**Blocked / unverified**
- … (build/tests/startup state)
EOF
)"
```

Optionally, write a one-line **project memory** so a future agent session recalls the
in-flight work without reading the issue: `<feature> in progress on <branch> — next:
<action>; see #<N>`.

### 6. Report

Give the user a four-line close-out:

```
Paused <feature> on `<branch>` @ `<sha>`. Build: <green/red>. Startup: <preflight ok?>.
Handoff → issue #<N> (comment). WIP commit: <sha or "none, tree clean">.
Next: <the single next action>.
Blocked: <red items, or "none">.
```

## Things this skill must not do

- **Never check in a handoff/plan file** (`HANDOFF.md`, `PLAN.md`, …). The durable record is
  the issue comment.
- **Never leave a dirty worktree** — commit a `wip:` or confirm clean. Lost uncommitted work
  is the failure mode this skill exists to prevent.
- **Never push, open, or merge a PR** — that's `shipyard:ship-pr` / a human call.
- **Never report a green state it didn't confirm** — if the build/tests weren't run, say
  "not run this session", don't imply they pass.
