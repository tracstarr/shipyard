# Shipyard

A portable **feature-delivery lifecycle** for Claude Code. Shipyard drives a unit of work
from idea → issue → plan → code → tests → runtime evidence → docs → review → green PR — in
**any repo**. It learns each project's stack, commands, and documented rules **at runtime**
(by reading the repo's `CLAUDE.md`/`AGENTS.md` and autodetecting its manifests), so there's
no per-project config to maintain.

The same lifecycle works on a .NET repo, a Node app, a Rust service, or a Python
project — it adapts to whatever you point it at.

## What's in the box

**Seven skills** (invoked as `shipyard:<name>`):

| Skill | Does |
|---|---|
| `shipyard:deliver-feature` | The orchestrator. Drives the whole lifecycle; delegates to the rest. |
| `shipyard:preflight` | Non-destructive "get this checkout ready" — deps, runtime files, infra, migrations. |
| `shipyard:verify` | Runtime evidence — boots the app, exercises the change live, proves the effect. |
| `shipyard:code-audit` | Pre-PR audit — runs the detected gates + delegates rule judgment to the `audit` workflow. |
| `shipyard:ship-pr` | Rebase → push → CI-to-green → triage the review bot's threads. |
| `shipyard:local-reset` | Destructive wipe + rebuild of the local dev environment. |
| `shipyard:handoff` | Pause-endgame — leave a clean, resumable state in the tracking issue. |

**Five bundled workflows** (parallel, report-only fan-outs, under `workflows/`):

| Workflow | Does |
|---|---|
| `test-gap.js` | Finds missing unit/integration/e2e coverage on the branch diff. |
| `doc-gap.js` | Finds missing/stale docs (changelog, rule-file sync, topic docs, how-to, API docs). |
| `audit.js` | Audits the diff against the project's **own** documented rules, clustered into domains. |
| `audit-deep.js` | Heavier audit: runs the gates + one reviewer per changed file + a 3-vote refutation panel per finding. |
| `rule-coverage.js` | Meta-audit: maps each documented rule to the mechanism that actually enforces it. |

## How it adapts to a project (no config file)

Every skill and workflow starts from one shared contract:
[`reference/discover-project.md`](reference/discover-project.md). It reads what the repo
already documents (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/`) and autodetects
the rest from manifests (`package.json`, `*.csproj`/`*.slnx`, `Cargo.toml`, `go.mod`,
`pyproject.toml`, `Makefile`, …): build/test/lint commands, the base branch, the PR tool
(`gh`/`glab`), CI, migrations, dev infra, the review bot, the feature-flag mechanism, and
any changelog convention.

The golden rule: **detect, then adapt. Where a phase has nothing to act on, say so and
skip it — never invent a command, a rule, or a convention the project doesn't have.** The
lifecycle spine always runs; only the project-specific gates flex with what's there.

## Install

Shipyard is its own single-plugin marketplace, so you can install it straight from a
checkout or a git remote.

```bash
# from a local clone:
/plugin marketplace add /path/to/shipyard
# …or straight from a git host:
/plugin marketplace add tracstarr/shipyard

/plugin install shipyard@shipyard
/plugin list            # confirm the seven shipyard:* skills appear
```

Then just talk to it: *"deliver this from issue #123 to a green PR"*, *"audit my branch"*,
*"ship this branch"*, *"get this worktree ready"*.

## The bundled workflows & `$CLAUDE_PLUGIN_ROOT`

Claude Code plugins can bundle **skills**, but **not** dynamic workflows as a first-class
component. So Shipyard ships the five `.js` workflows as plugin resources under
`workflows/`, and the skills invoke them **by absolute path**:

```
Workflow({ scriptPath: "$CLAUDE_PLUGIN_ROOT/workflows/audit.js", args: { base: "main", … } })
```

`$CLAUDE_PLUGIN_ROOT` is the plugin's install directory; the skills resolve it with
`echo "$CLAUDE_PLUGIN_ROOT"`. **Fallback** — if `scriptPath` invocation isn't available in
your setup, copy the workflows into your personal workflows dir once and invoke them by
name instead:

```bash
cp "$CLAUDE_PLUGIN_ROOT"/workflows/*.js ~/.claude/workflows/
# then the skills can use: Workflow({ name: "audit", args: { … } })
```

## Layout

```
.claude-plugin/
  plugin.json          # the plugin manifest
  marketplace.json     # self-marketplace (makes this dir installable)
reference/
  discover-project.md  # the shared runtime-autodetection contract (the DRY core)
skills/
  deliver-feature/SKILL.md   preflight/SKILL.md   verify/SKILL.md
  code-audit/SKILL.md        ship-pr/SKILL.md     local-reset/SKILL.md
  handoff/SKILL.md
workflows/
  test-gap.js   doc-gap.js   audit.js   audit-deep.js   rule-coverage.js
```

## Requirements

- **Claude Code** with plugin support.
- **git**, and for the PR/CI/review automation a PR CLI — **`gh`** (GitHub) or **`glab`**
  (GitLab), authenticated. Without one, the affected skills do the git half and hand the
  PR step to you.
- The bundled workflows run under Claude Code's Workflow runtime (multi-agent), not Node.

## Design notes

- **The spine is interactive; the fan-outs are autonomous.** `deliver-feature` keeps the
  human-in-the-loop gates (issue choice, scope discussion, plan approval, the mandatory
  feature-flag question) in the main loop and delegates the parallelizable analysis
  (test-gap, doc-gap, audit) to background workflows that return structured reports. The
  orchestrator writes the actual tests and docs itself, so new code lands in one reviewable
  place.
- **The gap workflows are report-only.** They never touch the worktree.
- **`audit.js` reads *your* rules.** It doesn't carry a built-in rule list; it extracts the
  non-negotiables your project documents, clusters them into domains, and audits against
  those — with an adversarial cross-check to drop false positives.

## License

MIT — see [LICENSE](LICENSE).
