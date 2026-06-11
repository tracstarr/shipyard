# Discover the project (Shipyard's shared autodetection contract)

Every Shipyard skill and workflow begins here. Shipyard ships no per-project config
file — instead it **learns the project at runtime** by reading what the repo already
documents and inferring the rest from its manifests. Detect first, then adapt. The
golden rule:

> **Detect, then adapt. Where a phase has nothing to act on, say so and skip it —
> never invent a command, a rule, or a convention the project doesn't have.**

A guessed build command that doesn't exist, a fabricated "rule 6," or a changelog entry
in a repo with no changelog are worse than honestly skipping the step. When detection is
genuinely ambiguous on something that matters (which of two test commands? does this
ship behind a flag?), **ask the user** rather than guess.

Run discovery **once** at the start of a session and carry the result (the "project
facts" below) through every step. The orchestrator (`deliver-feature`) passes the same
facts to the bundled workflows via `args` so they don't each re-derive them.

---

## What to read (rules & conventions)

Read whatever of these exist, in this order of authority, and treat them as the source
of truth for "how this project wants work done":

1. `CLAUDE.md` (and any `**/CLAUDE.md` in subtrees) — primary agent instructions.
2. `AGENTS.md` — generic agent entry point; often kept in sync with `CLAUDE.md`.
3. `.cursor/rules/*`, `.cursorrules`, `.github/copilot-instructions.md` — sibling rule files.
4. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `README.md`.
5. `docs/` — architecture, ADRs, coding standards, per-feature docs.

If the project has a **numbered or named list of non-negotiable rules** (like Winnow's
"25 non-negotiables"), capture it: that list is the rule source the `audit` and
`rule-coverage` workflows audit against. If there is no such list, the rules are
whatever these files state in prose plus the conventions visible in the code.

`RULES_FILE` = the single best rule file found (usually `CLAUDE.md`, else `AGENTS.md`,
else `CONTRIBUTING.md`, else none).

---

## What to detect (stack, commands, tooling)

Use Glob/Grep/Read and a few cheap shell probes. Confirm a command exists before relying
on it — read the manifest, don't assume a script name.

### Language & build/test/lint commands

| Signal file | Stack | Where the commands live |
|---|---|---|
| `package.json` | Node / TS / JS | `scripts` block — read it for `build`, `test`, `lint`, `typecheck`, `e2e`, `check:*` |
| `*.slnx` / `*.sln` / `*.csproj` | .NET / C# | `dotnet build <sln>`, `dotnet test <sln>` |
| `Cargo.toml` | Rust | `cargo build`, `cargo test`, `cargo clippy` |
| `go.mod` | Go | `go build ./...`, `go test ./...`, `go vet ./...` |
| `pyproject.toml` / `setup.cfg` / `requirements.txt` | Python | `pytest`, `ruff`/`flake8`, `mypy` (check the file for the configured tools) |
| `Gemfile` | Ruby | `bundle exec rake test` / `rspec` |
| `pom.xml` / `build.gradle` | Java/Kotlin | `mvn verify` / `./gradlew build test` |
| `composer.json` | PHP | `composer test` (read `scripts`) |
| `Makefile` / `Justfile` / `Taskfile.yml` | any | `make <target>` / `just <recipe>` — often the canonical entrypoint; **prefer these when present** |

Capture, for each that applies: `BUILD_CMD`, `TEST_CMD`, `LINT_CMD`, `TYPECHECK_CMD`,
`E2E_CMD`. A polyglot repo (e.g. .NET backend + Node frontend) has more than one of each —
keep them all, tagged by subtree. Leave a slot empty (and the corresponding step a no-op)
when the project genuinely has no such command.

### Test layers & frameworks

From the test config and existing test files, determine which layers exist: **unit**,
**integration** (touches a real DB/service), **e2e** (drives the app through a browser or
real entrypoint). Note the framework per layer (xUnit, vitest, jest, pytest, Playwright,
Cypress, go test, …) and where tests live. The `test-gap` workflow uses this.

### Version control & PR tooling

- Remote host: `git remote -v` → GitHub / GitLab / other.
- CLI: is `gh` available and authed (`gh auth status`)? GitLab → `glab`. If neither,
  PR/issue automation is unavailable — the affected skills degrade to "do the git half,
  hand the PR step to the user."
- Default branch: `git symbolic-ref refs/remotes/origin/HEAD` (fallback `main`/`master`).
  This is `BASE` for diffs and the rebase target.

### CI

`.github/workflows/*.yml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/`,
`Jenkinsfile`. Note which gates CI actually runs on PRs (it may exclude slow suites —
e.g. integration tests). `rule-coverage` and `code-audit` use this.

### Migrations / database

Detect a migration tool so preflight/local-reset/verify know how to apply schema and
where the data lives: EF Core (`dotnet ef`, `*DbContext`, `Migrations/`), Prisma
(`prisma/migrations`), Rails (`db/migrate`), Alembic (`alembic/`), Flyway
(`db/migration`), Drizzle, Knex, Django (`manage.py migrate`), Sequelize. If none, the
DB-related steps are no-ops.

### Dev infrastructure

`docker-compose*.yml` / `compose*.yml`, an `infra/` dir, `.devcontainer/`, a documented
"local setup" section. This is what preflight brings **up** and local-reset tears **down**.
Note any env-file convention (`.env.example`, `infra/.env.example`) and any gitignored
runtime files a worktree wouldn't inherit. If there's a project preflight/setup script
(`scripts/preflight.sh`, `bin/setup`, `make dev`), **prefer it** over re-deriving the steps.

### Review bot

Does an automated reviewer comment on PRs? Detect CodeRabbit (`.coderabbit.yaml`/`.yml`,
or comments by `coderabbitai[bot]`), or others. `ship-pr` triages its threads; with no
bot detected, that phase is skipped.

### Feature-flag / release-toggle mechanism

Look for a flags config section (e.g. a `Features`/`FeatureFlags` block, LaunchDarkly,
Unleash, `flipper`, a `flags.ts`), and how the UI/code reads it. `deliver-feature`'s
flag gate needs this; if the mechanism is unclear, that gate **asks the user** rather
than assuming one exists.

### Changelog / user-facing release notes

A `CHANGELOG.md`, a `changeset`-style `docs/changelog/entries/` dir, a "What's New"
surface. `doc-gap` only flags a missing changelog entry if the project actually keeps one.

---

## The "project facts" you carry forward

After discovery you should be able to state, concisely:

```
RULES_FILE      e.g. CLAUDE.md  (or "none — conventions are prose/code only")
RULE_LIST       the project's numbered/named non-negotiables, if any
STACKS          e.g. [".NET (src/backend)", "React/TS (src/frontend)"]
BUILD_CMD(S)    e.g. dotnet build App.slnx ; (cd web && npm run build)
TEST_CMD(S)     + which layers/frameworks exist (unit/integration/e2e)
LINT/TYPECHECK  the static gates that exist
BASE            default branch (rebase/diff target)
PR_TOOL         gh / glab / none
CI              the gates CI runs on PRs (and any it skips)
MIGRATIONS      tool + how to apply, or "none"
DEV_INFRA       compose/setup script + runtime files, or "none"
REVIEW_BOT      coderabbit / other / none
FLAG_MECH       how releases are toggled, or "none — ask at the flag gate"
CHANGELOG       the convention, or "none"
```

State the handful that matter for the current step out loud (briefly) so the user can
correct a misdetection before it costs work. You don't need to recite all of it every time.

## Passing facts to the bundled workflows

The workflows (`test-gap`, `doc-gap`, `audit`, `rule-coverage`) accept an `args` object.
Pass what you discovered so their agents don't re-derive it (they still confirm against
the live repo):

```
Workflow({
  scriptPath: "<plugin-root>/workflows/<name>.js",
  args: {
    base: BASE,
    rulesFile: RULES_FILE,
    projectFacts: {
      stacks: STACKS, buildCmd: ..., testCmd: ..., testLayers: [...],
      migrations: ..., reviewBot: ..., changelog: ..., ci: ...
    }
  }
})
```

`<plugin-root>` is the value of the `$CLAUDE_PLUGIN_ROOT` environment variable. If you
don't already know it, get it with `echo "$CLAUDE_PLUGIN_ROOT"` (Bash) and build the
absolute path. See each skill's "Invoking the bundled workflows" note.

## Degradation rules (the spine survives a sparse project)

- **No rule file** → audit against visible code conventions + general best practice; say
  the rule set was inferred, not documented.
- **No CI / no PR tool** → run gates locally; hand the PR/issue steps to the user.
- **No migrations / no dev-infra** → preflight, verify, and local-reset say "nothing to
  do here" for those legs and move on.
- **No changelog / no flags** → don't manufacture them; note the step is N/A.
- **Monorepo / polyglot** → scope each command to its subtree; run the gates that apply
  to the changed files.

The lifecycle spine (issue → discuss → plan → flag-gate → implement → tests → verify →
docs → review → ship) always runs; only the *project-specific gates* flex with what's there.
