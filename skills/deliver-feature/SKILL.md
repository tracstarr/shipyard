---
name: deliver-feature
description: End-to-end feature-delivery driver for any repo — take a piece of work from a tracking issue (existing or newly created from the conversation) all the way to a green, review-ready PR. Runs the whole lifecycle interactively, stopping at the human-in-the-loop gates a background job can't make: it picks or creates the issue, discusses it with the user to align on scope before any planning, drafts an implementation plan and gets it approved in plan mode, ALWAYS asks before implementation whether the work should sit behind a feature flag / release toggle, implements on a feature branch, then ensures unit + integration + e2e tests cover the new work (delegating gap-finding to the bundled `test-gap` workflow), ensures docs are created/updated including any user-facing changelog the project keeps (delegating to the bundled `doc-gap` workflow), runs the project's own pre-PR review via the `shipyard:code-audit` skill and fixes the serious findings, and finally hands off to `shipyard:ship-pr` to open the PR and babysit CI to green. The skill is project-agnostic: it learns the repo's stack, commands, and documented rules at runtime (see the discovery contract) rather than hardcoding them. Use this whenever the user wants to "build this feature", "implement this issue", "take this from issue to PR", "deliver this end to end", "do the whole thing", "ship a new feature", "start from issue #N", or describes a chunk of work and wants it driven from idea → issue → plan → code → tests → docs → review → green PR. It is the orchestrator; it reuses the sibling Shipyard skills and bundled workflows rather than re-implementing them.
---

# Deliver Feature

Drive a unit of work from "here's what we want to build" all the way to "PR open, CI
green, every gate satisfied, ready for human merge" — in **whatever repo you're in**.

This is the **orchestrator**. It owns the interactive, human-in-the-loop spine of the
lifecycle and *delegates* the parallel, autonomous phases:

| Phase | Owner | Why |
|---|---|---|
| Discover the project | this skill (once, up front) | every later step adapts to what's found |
| Issue intake | this skill (interactive) | needs a decision: pick vs create |
| Discuss & align | this skill (interactive) | shared scope before any plan |
| Plan + approval | this skill (plan mode) | plan approval is a main-loop gate |
| Feature-flag decision | this skill (**always asks**) | a human call, every time |
| Implementation | this skill | one coherent, reviewable context |
| Test-gap analysis | `test-gap` **workflow** | fans out across surfaces |
| Runtime evidence | `shipyard:verify` **skill** | boots the app, exercises the change live |
| Doc-gap analysis | `doc-gap` **workflow** | fans out across doc dimensions |
| Self code review | `shipyard:code-audit` **skill** | runs the real gates + rule judgment |
| PR + CI to green | `shipyard:ship-pr` **skill** | sequential, destructive git loop |

The two gap workflows are **report-only** — they find gaps in parallel and hand back a
structured list. *This skill writes the actual tests and docs* back in the main loop, so
the new code lands in one place a human can watch and review.

> **Workflow authorization.** This skill explicitly authorizes calling the `Workflow`
> tool for the two gap-analysis phases below (the bundled `test-gap` and `doc-gap`).
> That is the opt-in — do not invoke any other workflow without a fresh user request.

## Step 0a: Discover the project (do this first, always)

Before anything else, learn the repo per
**`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**. Carry the resulting "project
facts" (rule file, build/test/lint commands, base branch, PR tool, migrations, dev infra,
review bot, flag mechanism, changelog convention) through every step below, and pass them
to the bundled workflows via `args`. Everything that follows adapts to what you found;
where a project lacks a phase's prerequisite, say so and skip — don't invent it.

### Invoking the bundled workflows

The `test-gap` and `doc-gap` workflows ship inside this plugin, so they are **not**
resolvable by name. Invoke them by path:

```bash
echo "$CLAUDE_PLUGIN_ROOT"   # the plugin's install dir
```

```
Workflow({ scriptPath: "<that path>/workflows/test-gap.js",
           args: { base: BASE, rulesFile: RULES_FILE, projectFacts: {…} } })
```

(If `scriptPath` is ever unavailable, the README documents the one-time fallback: copy
`workflows/*.js` into `~/.claude/workflows/` and invoke by `{ name }`.)

---

## The lifecycle (run in order)

```
0a. Discover         — learn the repo's stack, commands, and rules (above)
0b. Pre-flight       — environment health + clean tree + branch off base
1.  Issue intake     — pick an existing tracking issue OR create one from the convo
2.  Discuss & align  — talk it through, resolve ambiguity, agree scope BEFORE planning
3.  Plan             — draft a grounded plan, approve it in plan mode
4.  Feature-flag gate— ASK whether to flag the work (mandatory, every time)
5.  Implement        — build per the approved plan, honoring the project's rules
6.  Tests            — test-gap → write missing tests → all green
7.  Runtime evidence — shipyard:verify → exercise the change live, capture proof
8.  Docs             — doc-gap → write docs (+ changelog if the project keeps one)
9.  Self review      — shipyard:code-audit → fix the serious findings
10. Ship             — shipyard:ship-pr → PR + CI to green
11. Close-out        — link the issue, report what shipped
```

Never skip a step silently. If a step doesn't apply (nothing user-visible ⇒ no changelog
entry; no migrations ⇒ nothing to verify server-side), say so out loud and move on.

---

## Step 0b: Pre-flight

Read these before doing anything:

```bash
git rev-parse --abbrev-ref HEAD        # current branch
git status --porcelain                 # working tree state
```

- **Environment health.** Delegate the environment check to **`shipyard:preflight`** —
  don't re-derive it here. Run it in repair mode so the workspace is actually ready
  (runtime files, dependencies installed, dev infra up, migrations applied — whatever the
  project has). If it reports a blocking failure it can't repair, stop and surface it;
  building on a broken environment just produces false failures downstream. If state is
  corrupted beyond repair, fall back to `shipyard:local-reset`.
- **Branch.** If on the base branch (`main`/`master`/detected default), do NOT implement
  on it. Create a feature branch after the plan is approved, named from the issue
  (`feat/<slug>` / `fix/<slug>`). If already on a feature branch, use it.
- **Clean tree.** If there are uncommitted changes unrelated to this work, surface them
  and ask whether to stash, commit, or proceed — don't silently fold them in.

---

## Step 1: Issue intake

Every delivery is anchored to a tracking issue — durable cross-session tracking belongs
in the issue tracker, not a checked-in plan file. (If the project has no issue tracker /
no `gh`·`glab`, anchor to a clear written scope in the conversation and the PR body
instead, and say so.)

**If the user named an issue** (`#N`, a URL, or "the X issue"): fetch and read it fully.

```bash
gh issue view <N> --json number,title,body,labels,state,url   # or: glab issue view <N>
```

If it's closed, surface that and confirm before continuing.

**If there's no issue yet**, draft one from the conversation and show it to the user for
approval before opening it — do not create an issue without sign-off:

- Title: conventional, scoped (`feat(area): …`, `fix(area): …`).
- Body: the problem, desired outcome, acceptance criteria, constraints. Write it so a
  cold reader could pick it up.

```bash
gh issue create --title "<title>" --body "<problem / outcome / acceptance criteria>"
```

Capture `ISSUE_NUMBER` / `ISSUE_URL` — the PR will reference them.

---

## Step 2: Discuss & align (before any planning)

The issue is the starting point, not the finished spec. Before drafting a plan, **talk it
through** so the plan is built on a shared picture instead of a guess. This runs every
time — even when the issue looks self-explanatory — but keep it proportional: a crisp
issue gets a short play-back and a confirm; a vague one gets a real conversation. Stay in
the main loop here; plan mode is the next step.

- **Play the issue back in your own words** — restate problem, outcome, acceptance
  criteria, so a misread is caught before it costs a plan.
- **Ground the read in the code.** Skim the slice you'd touch and the relevant docs, then
  name the files/surfaces you think are in scope — and the ones you think are *out*.
- **Surface the real decisions.** Call out ambiguities, unstated assumptions, edge cases,
  and anything that fights a documented rule or the existing design. Where there's a
  genuine fork, put the options and your recommendation to the user (`AskUserQuestion`
  suits the discrete ones).
- **Agree on scope.** Confirm what's in, what's explicitly deferred, and what "done"
  means for this pass. If the issue is really several pieces, agree whether to split it.

Close with an explicit alignment check — "here's what I'll plan against, good?" — and
don't slide into planning while a scope question is open. If the discussion materially
changes the issue, **update the issue body** so it stays the source of truth.

---

## Step 3: Plan

With scope agreed, enter **plan mode** (`EnterPlanMode`) and turn that shared
understanding into a concrete plan grounded in the actual codebase — the touched slice,
the relevant docs, and the project rules that apply to the surfaces you'll change. The
plan must cover:

- The concrete files/surfaces to add or change (backend, any migration with the right
  tool/context, frontend + any generated client, etc. — whatever the stack has).
- The test surface: which behaviors get unit / integration / e2e coverage.
- The docs surface: topic docs, user-facing how-to, and whether the change is
  user-visible (⇒ a changelog entry, if the project keeps one).
- Whether a feature flag is in scope (decided in Step 4, but write the plan so the flag
  can be threaded in cleanly).

Present with `ExitPlanMode` and get explicit approval before writing code. If approval
comes back with changes, revise and re-present.

---

## Step 4: Feature-flag gate (mandatory — always ask)

**Before writing implementation code, always ask the user whether this work should ship
behind a feature flag / release toggle.** This is non-negotiable and happens on every
run, even if it seems obvious. Use `AskUserQuestion`. Frame the trade-off:

- **Flag it** when the work is unreleased / in-progress, or you want to merge incrementally
  and flip it on later without a redeploy. Wire it through the project's detected flag
  mechanism. If the project has **no** flag mechanism, say so and discuss the alternative
  (a draft PR, a separate branch, or shipping it released) — don't fabricate a flag system.
- **Don't flag it** for backend-only work, bug fixes, or small self-contained changes safe
  to release immediately. A flag with no purpose is just debt.

Record the decision; if flagged, fold the flag plumbing into Step 5.

---

## Step 5: Implement

Build per the approved plan. Create the feature branch now if you were on the base branch.
**Honor the project's documented rules** (the ones you captured in discovery) for every
surface you touch — re-read the relevant ones before editing rather than working from
memory. Match the surrounding code's style, naming, and idiom. Commit in logical,
conventional-commit chunks as you go.

If the stack has a generated client / codegen step that a backend change invalidates
(detected in discovery), regenerate it and commit the regenerated artifacts alongside the
change.

---

## Step 6: Tests — cover the new work (unit + integration + e2e)

First make sure the new code's own tests pass, then find what's missing.

**Delegate gap-finding to the bundled workflow** (by `scriptPath`, with the project facts):

```
Workflow({ scriptPath: "<plugin-root>/workflows/test-gap.js",
           args: { base: BASE, projectFacts: {…} } })
```

It fans out across the changed surfaces, adversarially verifies each gap (so it won't cry
"missing test" for something already covered), and returns
`{ summary, gaps: [{ surface, layer, file, severity, what, suggestedTest, suggestedTestPath }] }`.

Then, **in this main loop**, write the missing tests yourself using the project's detected
frameworks and locations (unit / integration / e2e). Run the suites to green before moving
on, using the detected `TEST_CMD`(s). If a layer needs infra that isn't up (a real DB for
integration), bring it up via `shipyard:preflight` rather than reporting the suite as
failing because infra was down. Decide with the user how exhaustive the slow e2e layer
needs to be; at minimum cover the primary new user flow.

---

## Step 7: Runtime evidence — prove it works live

Tests green ≠ feature works. Before documenting and reviewing, **invoke `shipyard:verify`**
to boot the app and exercise the actual change, then capture the evidence.

`verify` complements the e2e suite: e2e covers user-facing UI flows, so this matters most
for what e2e doesn't reach — a new endpoint with no UI yet, a job/cron, a background
service, a migration side effect. Treat the result as a gate:

- **PASS** — record the runtime-evidence block (observed status, payload, effect) for the
  PR description; move on.
- **FAIL** — a runtime failure is the top-priority finding for this change, above any
  convention nit. Fix it and re-verify before docs/review.

If the change is a pure UI flow already covered by an e2e spec, say so and lean on that.
If nothing runs server-side and there's no observable effect (docs-only / test-only),
note there's nothing to live-verify and move on.

---

## Step 8: Docs — update/create, including user-facing how-to

**Delegate gap-finding to the bundled workflow:**

```
Workflow({ scriptPath: "<plugin-root>/workflows/doc-gap.js",
           args: { base: BASE, projectFacts: {…} } })
```

It checks, in parallel: a user-facing changelog (only if the project keeps one),
rule-file ⇄ sibling-rule-file sync (e.g. `CLAUDE.md` ⇄ `AGENTS.md`), topic docs,
user-facing how-to, and API/interface doc-comments. It returns
`{ summary, userVisible, gaps: [{ kind, path, severity, what, suggestedAction }] }`.

Then **write the docs yourself** in the main loop:

- **Changelog.** If the project keeps one and `userVisible` is true, add an entry in the
  project's format and voice. If the project has no changelog, or nothing is user-visible,
  add nothing and say so.
- **User-facing how-to.** New screen/flow ⇒ how-to content that tells a user how to use it
  (distinct from a changelog blurb and from dev docs).
- **Topic docs / ADRs.** Update the page that now contradicts the code; create one for a
  substantial new subsystem; add an ADR for an architectural decision if the project uses
  ADRs.
- **Rule-file sync.** If you changed a documented rule, update every rule file that
  mirrors it (e.g. both `CLAUDE.md` and `AGENTS.md`).

---

## Step 9: Self code review

Run the project's own audit before involving CI or any external reviewer. **Invoke
`shipyard:code-audit`** — it runs the real gates (the detected build/test/lint/typecheck,
plus a secrets sweep) and delegates the rule judgment to the bundled `audit` workflow,
emitting a graded P0–P3 report.

Then act on it in the main loop:

- **P0** (build/test/security breakers) and **P1** (correctness / rule violations) — fix
  before shipping.
- **P2 / P3** — fix if cheap; otherwise note them in the PR description as known follow-ups.

Re-run the relevant gate after fixing so you know it's actually closed.

---

## Step 10: Ship — PR + CI to green

Hand off to **`shipyard:ship-pr`**. It rebases on the base branch, opens or updates the
PR, pushes with `--force-with-lease`, watches CI to a terminal state, and (if the project
has a review bot) triages its threads — accepting real fixes, rejecting suggestions that
fight the project's rules — until CI is green and every thread is resolved.

Make sure the PR body links the issue so it auto-closes on merge (`Closes #<N>` on GitHub).
`ship-pr` leaves the PR review-ready; it never merges (that's a human decision).

---

## Step 11: Close-out

Report a short summary:

```
Issue #<N> → PR #<M> (<url>). CI green at <sha>.
Tests: <X> added (unit/integration/e2e). Runtime: <verified live / e2e-covered / n/a>.
Docs: <Y> (+changelog: yes/no/na). Feature flag: <name or "none">.
Self-review: <A> P0/P1 fixed. Ready for human review and merge.
```

If anything is left open (an e2e flow deferred, a P2 noted as follow-up, a CI stalemate
`ship-pr` bounced off), list it plainly.

---

## Things this skill must not do

- **Never skip discovery** (Step 0a) — every later step depends on knowing the project.
- **Never jump from the issue straight into planning or code** — Step 2 (discuss & align)
  runs first, every time.
- **Never skip the feature-flag question** (Step 4). It runs every time.
- **Never implement on the base branch** — branch first.
- **Never open an issue or PR without showing the user the draft first.**
- **Never check in implementation plans or review artifacts** — durable tracking goes in
  the issue.
- **Never invoke workflows other than the bundled `test-gap` / `doc-gap`** without a fresh
  user request — those two are the only pre-authorized ones here.
- **Never let the gap workflows write code** — they are report-only; this skill writes the
  tests and docs so it all lands reviewably in one place.
- **Never merge the PR** — `ship-pr` stops at review-ready by design.
- **Never invent a command, rule, flag mechanism, or changelog the project doesn't have** —
  detect, adapt, and skip what's absent.

## When this skill is the wrong tool

- **A one-line fix or quick question.** This is the full lifecycle; for a tiny change,
  just make it (and add a changelog entry if the project keeps one and it's user-visible).
- **Pure review / audit with no implementation.** Use `shipyard:code-audit`.
- **A branch that's already code-complete and just needs shipping.** Skip to `shipyard:ship-pr`.
- **Local environment is broken.** Reset with `shipyard:local-reset` first, then come back.
- **Cross-team work** where issue scope, the flag call, or review-bot accepts aren't solely
  the user's to make — defer those gates to humans.
