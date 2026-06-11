/**
 * audit-deep — high-confidence, per-file branch audit (any repo).
 *
 * A dynamic workflow (https://code.claude.com/docs/en/workflows). The runtime runs this in
 * the background and fans the work across subagents, so the caller's context only ever
 * holds the final graded report.
 *
 * REPORT-ONLY. No agent modifies files. This is the HEAVIER sibling of `audit.js`:
 *   - `audit.js`      → rule-cluster sweep: a few domain agents each scan the whole diff.
 *   - `audit-deep.js` → per-FILE review: one reviewer per changed file against the project
 *                       rules relevant to that file's category, the project's gates run in
 *                       the same pass, and every finding faces a 3-skeptic refutation panel.
 * Use this when you want maximum confidence and granularity; use `audit.js` for a fast
 * rule-cluster sweep.
 *
 * Project-agnostic: it reads the project's documented rules (clustered into the same
 * generic domains as `audit.js`), maps each changed file to the domains that govern it,
 * and runs the project's DETECTED gates (build/test/lint) — nothing about one stack is
 * hardcoded.
 *
 * Shape:
 *   Phase 1  Scope    — resolve base/diff + bucket files, and (in parallel) enumerate the
 *                       project's rules clustered by domain
 *   Phase 2  Gates    — run detected build/test/lint + a secrets/commit branch check
 *                       (kicked off here, awaited after Review so the two overlap)
 *   Phase 3  Review   — one agent per changed file against its category's project rules
 *   Phase 4  Verify   — 3-vote adversarial refutation panel per finding (pipelined)
 *
 * args (global, optional):
 *   { base?: string = "main", rulesFile?: string = "CLAUDE.md", projectFacts?: object }
 *
 * Returns: { scope, gates, findings, droppedCount, droppedSample, empty }
 */

export const meta = {
  name: "audit-deep",
  description:
    "Report-only, high-confidence branch audit: runs the project's detected gates, fans out one reviewer per changed file against the project's rules for that file's category, and refutes each finding with a 3-skeptic adversarial panel to drop false positives. Graded P0–P3. Heavier and more granular than the `audit` workflow's rule-cluster sweep.",
  phases: [
    { title: "Scope", detail: "resolve base/diff, bucket files, enumerate project rules" },
    { title: "Gates", detail: "detected build/test/lint + secrets/commit checks (overlaps Review)" },
    { title: "Review", detail: "one reviewer per changed file against its category's rules" },
    { title: "Verify", detail: "3-vote adversarial refutation panel per finding" },
  ],
};

const A = typeof args === "object" && args ? args : {};
const base = A.base || "main";
const rulesFile = A.rulesFile || "CLAUDE.md";
const facts = A.projectFacts || {};

// Generic file buckets and the rule domains that govern each. The domains match audit.js.
const BUCKETS = [
  "backend-api",
  "backend-domain",
  "migration",
  "job-or-service",
  "frontend-component",
  "frontend-style",
  "config",
  "docs",
  "scripts",
  "other-code",
  "unknown",
];

const BUCKET_DOMAINS = {
  "backend-api": ["api-interface", "authz-security"],
  "backend-domain": ["data-persistence", "api-interface"],
  migration: ["data-persistence"],
  "job-or-service": ["authz-security", "data-persistence"],
  "frontend-component": ["frontend-ui"],
  "frontend-style": ["frontend-ui"],
  config: ["hygiene-config-docs", "authz-security"],
  docs: ["hygiene-config-docs"],
  scripts: ["hygiene-config-docs"],
  "other-code": ["other", "api-interface", "data-persistence"],
  unknown: ["authz-security", "data-persistence", "api-interface", "frontend-ui", "hygiene-config-docs", "other"],
};

const DOMAIN_CATALOG = [
  ["authz-security", "auth/authorization, permissions, secrets handling, injection, crypto, tenancy."],
  ["data-persistence", "schema & migrations, transactions, data integrity/immutability, audit trails, caching."],
  ["api-interface", "endpoint/handler conventions, request/response shapes, status codes, the public interface."],
  ["frontend-ui", "design tokens/theming, responsive & accessibility, generated-client usage, component conventions."],
  ["hygiene-config-docs", "no committed secrets, config-drift, no checked-in plan/review artifacts, doc/rule-file sync, flags, commits."],
  ["other", "any documented non-negotiable that doesn't fit the buckets above."],
];

// Generic, project-neutral guidance per category (the project's own rules are layered on top).
const CATEGORY_GUIDANCE = {
  "backend-api":
    "authorization present & correct for the action; inputs validated; correct status codes and typed/structured error responses (not a 500 for an expected 4xx); no secrets; handler stays thin (delegates to a service).",
  "backend-domain":
    "invariants enforced in code; correct nullability; data-integrity / immutability respected; no business logic leaking into the wrong layer.",
  migration:
    "safe/additive (expand-then-contract) — no destructive change to something still read by deployed code; meaningful name; no heavy data backfill inlined into a deploy-time migration.",
  "job-or-service":
    "background writes are attributed/audited as the project requires; idempotent; failure handling; correct registration/scheduling.",
  "frontend-component":
    "keyboard-operable with appropriate ARIA/semantics; responsive; uses the project's design tokens and generated API client rather than hardcoded values / hand-rolled fetch — ONLY if the project has those conventions.",
  "frontend-style":
    "uses the project's design variables/tokens for color/spacing/type if it has them; responsive; focus states intact.",
  config:
    "no committed secret values; any new key is propagated everywhere the project requires (defaults, example env, deploy var docs, container args).",
  docs:
    "mirrored rule files kept in sync; no parallel *-v2 copies; no checked-in implementation plans / review artifacts.",
  scripts: "no committed secrets; consistent with the project's config conventions.",
  "other-code": "general correctness; apply whatever project rules touch this file.",
  unknown: "manual review; apply the secrets sweep; flag anything that bypasses a documented rule.",
};

// ── Schemas ──────────────────────────────────────────────────────────────────
const FINDING = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line", "rule", "problem", "fix", "grade"],
  properties: {
    path: { type: "string", description: "repo-relative file path" },
    line: { type: "string", description: 'line number or range, e.g. "142" or "140-148"' },
    rule: { type: "string", description: "the project rule (or general principle) violated" },
    problem: { type: "string", description: "what is concretely wrong" },
    fix: { type: "string", description: "suggested fix direction" },
    grade: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
  },
};

const RULE = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    requirement: { type: "string" },
  },
  required: ["id", "title", "requirement"],
};

const ENUMERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rulesSource: { type: "string" },
    domains: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", enum: DOMAIN_CATALOG.map((d) => d[0]) },
          rules: { type: "array", items: RULE },
        },
        required: ["key", "rules"],
      },
    },
  },
  required: ["domains"],
};

const SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hasDiff", "base", "head", "branch", "files"],
  properties: {
    hasDiff: { type: "boolean" },
    base: { type: "string", description: "resolved base commit sha or ref" },
    head: { type: "string" },
    branch: { type: "string" },
    note: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "status", "bucket"],
        properties: {
          path: { type: "string" },
          status: { type: "string", description: "git status letter: A/M/D/R..." },
          bucket: { type: "string", enum: BUCKETS },
        },
      },
    },
  },
};

const GATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gates"],
  properties: {
    gates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["gate", "status", "notes"],
        properties: {
          gate: { type: "string" },
          status: { type: "string", enum: ["pass", "fail", "skipped"] },
          notes: { type: "string", description: "first ~30 lines of failure output, or short pass note" },
        },
      },
    },
  },
};

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: { findings: { type: "array", items: FINDING } },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refuted", "reason"],
  properties: {
    refuted: { type: "boolean", description: "true if the finding is wrong, inapplicable, or already satisfied" },
    reason: { type: "string" },
  },
};

const repoNote =
  "Work in the current repository (the workflow's working directory is the repo root). Use " +
  "git via the Bash tool; do not hardcode any absolute path.";

// ===========================================================================
// Phase 1 — Scope (files) + Enumerate (rules), in parallel
// ===========================================================================
phase("Scope");

const bucketTable =
  "Bucketing rules (path/role -> bucket), first match wins; ambiguous -> 'unknown':\n" +
  "- backend-api: server endpoint/handler/controller/route files (HTTP surface).\n" +
  "- backend-domain: server domain/model/entity/service/business-logic files.\n" +
  "- migration: DB schema migration files (any migration tool).\n" +
  "- job-or-service: background jobs, scheduled tasks, hosted/worker services, queue handlers.\n" +
  "- frontend-component: UI component files (.tsx/.jsx/.vue/.svelte and the like).\n" +
  "- frontend-style: stylesheets (.css/.scss/styling modules).\n" +
  "- config: app config, env files (NOT *.example), infra/compose, Dockerfiles, CI config.\n" +
  "- docs: docs/**, *.md, rule files.\n" +
  "- scripts: build/dev/ops scripts.\n" +
  "- other-code: any other source file not covered above.\n" +
  "- unknown: anything else.";

const [scope, enumerated] = await parallel([
  () =>
    agent(
      "You are the SCOPE resolver for a deep code audit. " + repoNote + "\n\n" +
        "1. Resolve the base: BASE = `git merge-base " + base + " HEAD` (if `" + base +
        "` doesn't resolve, try `origin/" + base + "` then `main`/`master`). HEAD = current " +
        "commit; branch = `git rev-parse --abbrev-ref HEAD`.\n" +
        "2. Changed files: `git --no-pager diff --name-status $(git merge-base " + base +
        " HEAD)...HEAD`. Include renames/deletes. Zero changed files → hasDiff=false and an " +
        "empty files array (do NOT fail).\n" +
        "3. Bucket EVERY changed path. Don't guess — ambiguous goes to 'unknown'.\n" +
        bucketTable +
        "\n\nReturn the structured scope. hasDiff=true iff there is at least one changed file.",
      { phase: "Scope", label: "scope:resolve", schema: SCOPE_SCHEMA }
    ),
  () =>
    agent(
      "You are the RULE-ENUMERATION pass of a deep code audit. " + repoNote + " Do NOT modify " +
        "files.\n\nTASK: read the project's rule file(s) — start with `" + rulesFile + "`, and " +
        "also AGENTS.md, CONTRIBUTING.md, and any coding-standards/rules docs — and extract " +
        "the project's NON-NEGOTIABLE rules. Assign EACH to exactly one domain:\n" +
        DOMAIN_CATALOG.map((d) => `- ${d[0]}: ${d[1]}`).join("\n") +
        "\n\nReturn `domains` as [{ key, rules:[{id,title,requirement}] }], omitting empty " +
        "domains, and `rulesSource`. If the project documents NO rules, infer a small " +
        "sensible set from the code and best practice, and set rulesSource to 'inferred from " +
        "code + best practice'.",
      { phase: "Scope", label: "scope:rules", schema: ENUMERATE_SCHEMA }
    ),
]);

if (!scope || !scope.hasDiff) {
  log("No diff vs base — nothing to audit.");
  return { scope: scope || null, gates: [], findings: [], droppedCount: 0, empty: true };
}

// Build domain -> rules lookup from the enumeration.
const rulesByDomain = {};
((enumerated && enumerated.domains) || []).forEach((d) => {
  if (d && d.key) rulesByDomain[d.key] = d.rules || [];
});
const rulesSource = (enumerated && enumerated.rulesSource) || rulesFile;

const counts = scope.files.reduce(
  (acc, f) => ((acc[f.bucket] = (acc[f.bucket] || 0) + 1), acc),
  {}
);
log(
  `Scope: ${scope.branch} — ${scope.files.length} file(s). ` +
    Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" · ") +
    ` | rules from ${rulesSource}`
);

// ===========================================================================
// Phase 2 — Gates (kicked off now, awaited after Review so the two overlap)
// ===========================================================================
phase("Gates");

const detectedGates = facts.buildCmd || facts.testCmd || facts.lintCmd || facts.typecheckCmd
  ? "Use the project's detected commands where given: " +
    JSON.stringify(
      {
        build: facts.buildCmd || null,
        test: facts.testCmd || null,
        typecheck: facts.typecheckCmd || null,
        lint: facts.lintCmd || null,
        projectChecks: facts.projectChecks || null,
      },
      null,
      0
    ) + ". For any not given, detect it from the project's manifests/Makefile."
  : "Detect the project's gate commands from its manifests (package.json scripts, " +
    "Makefile/Justfile, *.csproj/*.slnx, Cargo.toml, go.mod, pyproject.toml, …).";

const gatesPromise = parallel([
  () =>
    agent(
      "Run the project's STATIC GATES from the repo root (Bash tool), sequentially, " +
        "capturing pass/fail + the first ~30 lines of any failure. " + detectedGates + "\n\n" +
        "Run, in order, those that exist: build, then the test suite, then typecheck, then " +
        "lint, then any project-specific check scripts. If a suite needs infrastructure that " +
        "isn't running (e.g. a database for integration tests), mark that gate 'skipped' with " +
        "a note to boot it — do NOT report it as 'fail'. Return one gates[] entry per command.",
      { phase: "Gates", label: "gate:static", schema: GATES_SCHEMA }
    ),
  () =>
    agent(
      "BRANCH-LEVEL checks from the repo root (Bash tool). base=" + base + ".\n\n" +
        "A) Secrets sweep — grep the diff (exclude *.example) for committed credentials:\n" +
        "   git --no-pager diff $(git merge-base " + base + " HEAD)...HEAD -- ':!**/*.example'\n" +
        "   Flag any line assigning a concrete literal to a key like " +
        "password/passwd/secret/api_key/private_key/signing_key/bearer/access_token/" +
        "refresh_token, OR matching 'BEGIN ... PRIVATE KEY' / AKIA[0-9A-Z]{16} / " +
        "AIza[0-9A-Za-z_-]{35} / ghp_[A-Za-z0-9]{36}. Exclude well-known local dev " +
        "placeholders. Each real hit → a P0 finding with path:line.\n" +
        "B) Commit-message lint — `git --no-pager log $(git merge-base " + base +
        " HEAD)..HEAD --format=%H%n%s`. Every subject must match " +
        "^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\\([^)]+\\))?!?: .+ " +
        "→ a non-matching subject is a P2 finding (path = the short sha).\n\n" +
        "Return all findings (empty array if clean). P0 for secrets, P2 for commit messages.",
      { phase: "Gates", label: "branch:secrets+commits", schema: FINDINGS_SCHEMA }
    ),
]);

// ===========================================================================
// Phase 3+4 — Review (one agent per file) -> Verify (3-vote refute panel)
// Pipelined: a file's findings start verifying as soon as that file's review lands.
// ===========================================================================
phase("Review");

const reviewed = await pipeline(
  scope.files,
  // Stage 1 — review one file against its category's project rules + generic guidance
  (file) => {
    const domainsForBucket = BUCKET_DOMAINS[file.bucket] || BUCKET_DOMAINS.unknown;
    const projectRules = domainsForBucket
      .flatMap((dk) => (rulesByDomain[dk] || []).map((r) => `- [${r.id}] ${r.title}: ${r.requirement}`))
      .join("\n");
    const guidance = CATEGORY_GUIDANCE[file.bucket] || CATEGORY_GUIDANCE.unknown;
    return agent(
      "You are reviewing ONE changed file in a deep code audit. " + repoNote + "\n" +
        `File: ${file.path}  (git status: ${file.status}, category: ${file.bucket})\n\n` +
        "Read the current file (if not deleted) AND its diff hunk:\n" +
        `  git --no-pager diff $(git merge-base ${base} HEAD)...HEAD -- "${file.path}"\n\n` +
        "Review it against (a) the PROJECT'S OWN RULES for this category and (b) the generic " +
        "guidance. Report ONLY concrete violations you can tie to a real line — do not invent " +
        "issues; an empty findings array is the correct answer for a clean file.\n\n" +
        "GENERIC GUIDANCE (" + file.bucket + "): " + guidance + "\n\n" +
        "PROJECT RULES FOR THIS CATEGORY:\n" +
        (projectRules || "(none enumerated for this category — rely on the generic guidance " +
          "and any rule you can see the file itself is bound by)") +
        "\n\nGrade: P0 = must-fix before merge (security, auth bypass, data-integrity break, " +
        "broken build contract, committed secret); P1 = fix unless justified; P2 = follow-up; " +
        "P3 = nit. For each finding give path:line, the rule (project rule id/title or the " +
        "generic principle), what's wrong, and a fix direction.",
      { phase: "Review", label: `review:${file.path.split("/").pop()}`, schema: FINDINGS_SCHEMA }
    );
  },
  // Stage 2 — 3-vote adversarial refutation panel per finding
  (review, file) =>
    parallel(
      (review && review.findings ? review.findings : []).map((f) => () =>
        parallel(
          [1, 2, 3].map((i) => () =>
            agent(
              `You are skeptic #${i} of 3 independently verifying a code-audit finding. ` +
                repoNote + " Re-check it yourself against the ACTUAL code — do not trust the " +
                "reviewer.\n\nFinding:\n" +
                `  file: ${f.path}\n  line: ${f.line}\n  grade: ${f.grade}\n` +
                `  rule: ${f.rule}\n  problem: ${f.problem}\n\n` +
                "Read the file and the cited rule. Set refuted=true ONLY if you can concretely " +
                "show the finding is wrong, inapplicable to this code, or already satisfied " +
                "(cite why). If it genuinely stands, refuted=false. Do not refuse on " +
                "uncertainty alone — investigate.",
              {
                phase: "Verify",
                label: `verify:${f.path.split("/").pop()}:${f.line}#${i}`,
                schema: VERDICT_SCHEMA,
              }
            )
          )
        ).then((votes) => {
          const v = votes.filter(Boolean);
          const refutes = v.filter((x) => x.refuted).length;
          return { ...f, file: file.path, refuted: refutes >= 2, votes: v.length, refutes };
        })
      )
    )
);

// ===========================================================================
// Collect + filter
// ===========================================================================
const verifiedFindings = reviewed.flat().filter(Boolean);
const confirmed = verifiedFindings.filter((f) => !f.refuted);
const dropped = verifiedFindings.filter((f) => f.refuted);
log(
  `Review complete: ${verifiedFindings.length} raw findings, ${dropped.length} refuted by ` +
    `the panel, ${confirmed.length} confirmed.`
);

const gateGroups = (await gatesPromise).filter(Boolean);
const gates = gateGroups.flatMap((g) => (g.gates ? g.gates : []));
const branchFindings = gateGroups.flatMap((g) => (g.findings ? g.findings : []));

const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
const allFindings = [...confirmed, ...branchFindings].sort(
  (a, b) => (order[a.grade] != null ? order[a.grade] : 9) - (order[b.grade] != null ? order[b.grade] : 9)
);

return {
  scope: { base: scope.base, head: scope.head, branch: scope.branch, files: scope.files, counts },
  rulesSource,
  gates,
  findings: allFindings,
  droppedCount: dropped.length,
  droppedSample: dropped.slice(0, 8).map((d) => ({ path: d.path, line: d.line, rule: d.rule, refutes: d.refutes })),
  empty: false,
};
