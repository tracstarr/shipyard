---
name: code-audit
description: Audit the current feature branch against the project's own standards before opening or merging a PR, producing a P0/P1/P2/P3-graded report with `path:line` references. Use this skill whenever the user wants to "audit my branch", "check my changes", "verify standards", "run a pre-PR review", "do a code-quality check", "make sure this follows our rules", "lint the diff against our conventions", or any phrasing that combines branch/diff/PR with review/audit/standards/compliance/conventions. The skill is project-aware at runtime: it learns the repo's documented rules and its automated gates (see the discovery contract) and runs the existing gates (build, test, lint, typecheck, plus a secrets sweep) rather than re-implementing them, then delegates the per-rule judgment to the bundled `audit` workflow so the rule set lives in one place. Report-only; never auto-fixes. Prefer this over the generic `review` / `security-review` skills for a branch-level standards check inside a project that documents its own rules.
---

# Code Audit

Walk the current feature branch's diff against the project's standards and emit a graded
P0/P1/P2/P3 report. The skill exists because a project's rules are usually spread across
several files (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, coding-standards docs, ADRs) —
nobody, human or AI, reliably remembers the full list.

This is the **full pre-PR audit**: it runs the heavy gates the project already has,
persists a report, and **delegates the rule judgment to the bundled `audit` workflow**,
which reads the project's rule file and runs a parallel, adversarially-verified sweep. The
rule judgment lives in one place — the workflow — so the gates and the rule sweep can't
drift. (For just the fast rule sweep with no gates, invoke the `audit` workflow directly.)

**Report-only.** This skill never modifies application code, tests, configs, or migrations,
never auto-fixes findings, and never runs destructive commands. The only artifact it writes
is its own report (see step 8). If a non-mutating run is required (a CI invocation that must
not touch the worktree), pass `--no-write` and print the report inline only.

> **Workflow authorization.** This skill authorizes invoking the `Workflow` tool for the
> bundled `audit` workflow (only). That is the opt-in — do not invoke any other workflow
> without a fresh user request.

## When to take over from `/review` and `/security-review`

The built-in `/review` is for generic PR review; `/security-review` is for security
posture. Neither knows *this project's* documented rules. This skill drives whenever the
user is in a repo that documents its own conventions and asks for a branch-level standards
/ pre-PR audit. If they specifically ask for security posture only, hand off to
`/security-review`.

## Invocation

```
code-audit [--scope=branch|files|all] [--allow-dirty] [--no-write] [<paths…>]
```

Defaults: `--scope=branch`, base = the detected default branch, output = inline **and** a
report file. Pass `--no-write` to suppress the file (the report still prints inline).

## The flow

Walk these in order. Never skip a step silently — if a step doesn't apply, say so.

### 0. Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**: the
**rule file**, the **automated gates** (build / test / lint / typecheck commands and any
project-specific check scripts), the **base branch**, and what **CI** runs on PRs. These
drive steps 3 and 4.

### 1. Resolve scope

```bash
BASE=$(git merge-base origin/<default-branch> HEAD)
git diff --name-status "$BASE...HEAD"
```

- `--scope=files <paths>` → use those paths instead.
- `--scope=all` → all tracked files. Warn it's heavy and rarely what they want; confirm first.
- If the working tree is dirty and `--allow-dirty` was not passed, refuse and tell the
  user to commit, stash, or pass `--allow-dirty`. Never auto-stash.
- If the default-branch ref doesn't resolve, fall back; if nothing works, ask for the base.
- If the branch has no diff vs base, report "nothing to audit" and exit before running gates.

### 2. Categorize files

Bucket every changed path by the project's layout (controllers/handlers, domain/entities,
migrations, jobs, frontend components, styles, config, docs, scripts, …). Ambiguous paths
go to `unknown` — don't guess. Print the bucket counts before continuing.

### 3. Run the automated gates

**Pre-flight — environment health (check-only).** Confirm the environment is healthy via
`shipyard:preflight` in **check-only** mode (no repair — this skill must not mutate the
worktree). If it reports a blocking failure (DB down, deps missing), **stop and tell the
user** to repair it (`shipyard:preflight` repair, or `shipyard:local-reset`) before
re-running — don't proceed to the test gate and report hundreds of false failures because
infra wasn't up. Note pending-migration warnings in the report.

Run each **detected** gate, capture pass/fail + the first ~30 lines of any failure. Each
failure is a **P0** tagged with the gate name. Do not re-implement these — they are the
source of truth. Typical set (use what the project actually has):

```
<BUILD_CMD>        # e.g. dotnet build, npm run build, cargo build, go build ./...
<TEST_CMD>         # the test suite(s); note if CI skips a slow layer this run includes
<TYPECHECK_CMD>    # e.g. tsc / mypy, if present
<LINT_CMD>         # e.g. eslint / clippy / ruff, if present
<PROJECT_CHECKS>   # any repo-specific check scripts (config-drift, design-tokens, codegen-drift…)
```

Note for each gate what it covers, so failure notes are meaningful. If the local audit
runs gates CI skips (e.g. an integration suite CI filters out), call that out — local audit
may be the primary regression check for those.

### 4. Rule judgment — delegated to the `audit` workflow

Rather than re-encode the project's rules here (and let two copies drift), **delegate the
per-rule judgment to the bundled `audit` workflow**, which reads the project's rule file,
clusters the rules into parallel domains, and runs an adversarial cross-check that drops
false positives before returning. Invoke it by path, scoped to the same base:

```bash
echo "$CLAUDE_PLUGIN_ROOT"
```
```
Workflow({ scriptPath: "<that path>/workflows/audit.js",
           args: { base: "origin/<default-branch>", rulesFile: RULES_FILE, projectFacts: {…} } })
```

- `--scope=all` → add `repoWide: true` so the domains sweep invariants repo-wide.
- `--scope=files <paths>` → the workflow is diff-scoped; run it branch-scoped and note in
  the report that the rule sweep covered the branch diff, not the narrowed file set.

It returns `{ verdict, report, findings }` where each finding is
`{ domain, path, line, severity, rule, what, fix }`, already adversarially cross-checked.
**Fold these `findings` into this audit's finding set.** Don't re-walk the files by hand —
the workflow is the source of truth, and a parallel hand walk would only drift. If the
workflow can't run (a truly headless context with no agent runtime), say so explicitly
rather than silently skipping the rule sweep.

Files that landed in `unknown` (step 2) won't match any domain — list them under "Not
categorized — manual review recommended."

**Deeper pass (optional, higher confidence).** For a large or security-sensitive diff, or
when the rule-cluster sweep feels too coarse, invoke `workflows/audit-deep.js` instead. It
reviews **each changed file individually** against its category's project rules, **runs the
detected gates itself**, and refutes every finding with a **3-skeptic panel** to kill false
positives — slower and heavier (one reviewer per file + three verifiers per finding), but
the highest-confidence option. Same `args` shape; it returns
`{ scope, gates, findings, droppedCount }`. Fold its `findings` in the same way — and since
it runs the gates internally, you can skip re-running them in step 3 if you lead with it.

### 5. Commit-level checks

```bash
git log "$BASE..HEAD" --format="%H%n%s%n%b%n---"
```

- Every commit subject matches conventional-commit form:
  `^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?: .+`
  (scopes and `!` breaking-markers are valid — don't flag them).
- Each commit is one logical change. Flag a commit whose changeset spans unrelated buckets
  as **P2** unless the message explains the cross-cutting reason.

### 6. Secrets sweep

Grep the diff for credential shapes (passwords, API keys, tokens, private keys, known
cloud-key patterns). Exclude `*.example` files and well-known local dev placeholders. Any
real hit → **P0** with `path:line`.

### 7. Render the report

Sort findings P0 → P3:

```markdown
# Code Audit — <branch> — <date>

## Scope
`<base>..<head>`, N files changed — <bucket counts>

## Automated gates
| Gate | Result | Notes |
|------|--------|-------|
| <build> | ✅/❌ | |
| <test>  | ✅/❌ | |
| <lint/typecheck/project-checks> | ✅/❌ | |

## Findings
### P0 — must fix before merge
- `path:line` — <rule> — <what's wrong> — <fix direction>
### P1 — fix before merge unless justified
### P2 — follow-up acceptable
### P3 — nit

## End-of-flow checklist
- [x] Gates run · [x] Rule judgment delegated to `audit`, findings folded in
- [x] Commits reviewed · [x] Secrets sweep run · [x] Report written
```

### 8. Persist the report

Unless `--no-write` was passed, write the report where the project keeps review artifacts
if it has such a convention (e.g. a `docs/reviews/` dir), else a clearly-named file outside
tracked sources (and say where). Same-day re-runs on the same branch overwrite without
prompting. The report file is the **only** thing this skill writes to the worktree. Print
the same content inline regardless.

## Edge cases

- **No diff vs base** — "nothing to audit"; exit before gates.
- **Dirty tree** — refuse without `--allow-dirty`; never auto-stash.
- **No rule file** — the `audit` workflow audits against visible code conventions + general
  best practice; note in the report that the rule set was inferred, not documented.
- **Diff > 50 files** — chunk by category; declare a partial walk in the header. Run all
  gates regardless.

## End-of-flow checklist

Confirm out loud before declaring the audit complete:

- [ ] Right scope resolved (branch / files / all)
- [ ] Environment preflight passed check-only (or the skill refused with a clear message)
- [ ] Every detected gate ran and its result captured
- [ ] Every changed file landed in a bucket (or surfaced as `unknown`)
- [ ] Rule judgment delegated to `audit`; its findings folded in (each with `path:line`
      + grade + fix direction)
- [ ] Commit messages reviewed · [ ] Secrets sweep run
- [ ] Report rendered inline AND (unless `--no-write`) written
- [ ] Only the report file was written; no code/test/config/migration modified; no
      destructive command run

Skipping any item silently is the failure mode this skill exists to prevent.
