/**
 * rule-coverage — meta-audit of a project's harness (any repo).
 *
 * A dynamic workflow (https://code.claude.com/docs/en/workflows). It does NOT look for
 * rule *violations* (that's the `audit` workflow) — it asks the meta-question: for each
 * non-negotiable the project documents, WHAT ACTUALLY ENFORCES IT? A rule that lives only
 * in prose is enforced by reviewer/AI memory, the weakest possible mechanism. This
 * workflow finds those gaps so adding (or knowingly declining) a real gate becomes a
 * deliberate choice, not an accident.
 *
 * REPORT-ONLY. No agent modifies files. Every claimed enforcement is confirmed against the
 * actual test/script/analyzer/CI-job/hook before it's trusted, and an adversarial pass
 * downgrades nominal/partial matches, so the "unenforced" list is honest.
 *
 * Project-agnostic: it reads the project's rule file and looks for whatever enforcement
 * surfaces the project's stack provides (linters/analyzers, tests, check scripts, CI jobs,
 * runtime hooks). If a category doesn't exist in this stack, it simply finds nothing there.
 *
 * Shape:
 *   Phase 1  Enumerate   — one agent extracts the documented rules from the rule file
 *   Phase 2  Map         — per rule: find the mechanism(s) that enforce it ...
 *   Phase 3  Verify      — ... then adversarially confirm each claimed gate really bites
 *   Phase 4  Synthesize  — one agent emits a graded coverage matrix + action list
 *
 * args (global, optional): { rulesFile?: string = "CLAUDE.md", projectFacts?: object }
 * Returns: { verdict: string, report: string (markdown), coverage: Coverage[] }
 */

export const meta = {
  name: "rule-coverage",
  description:
    "Meta-audit of a project's harness: maps every documented non-negotiable to the mechanism that actually enforces it (linter/analyzer, automated test, check script, CI job, runtime hook, the audit judgment pass, or nothing), adversarially verifies each claimed gate really bites, and emits a graded coverage matrix that flags the rules enforced only by reviewer memory. Report-only.",
  phases: [
    { title: "Enumerate", detail: "extract the documented non-negotiables from the rule file" },
    { title: "Map", detail: "per rule, find the mechanism(s) that enforce it" },
    { title: "Verify", detail: "adversarially confirm each claimed gate really bites" },
    { title: "Synthesize", detail: "graded coverage matrix + action list for the gaps" },
  ],
};

const A = typeof args === "object" && args ? args : {};
const rulesFile = A.rulesFile || "CLAUDE.md";

// ── Enforcement-surface catalog (generic; agents confirm against live files) ──
const SURFACES =
  "ENFORCEMENT SURFACES to check for each rule — confirm against the LIVE files (read the " +
  "test bodies / script source / config), never assume a name implies coverage. Not every " +
  "stack has every surface; only what genuinely exists counts:\n" +
  "- STATIC ANALYSIS: compiler/linter/analyzer config that FAILS the build on violation " +
  "(e.g. warnings-as-errors, ESLint/clippy/ruff/mypy rules, custom analyzers, " +
  ".editorconfig severities, type-checker strictness).\n" +
  "- AUTOMATED TESTS: unit/convention/architecture tests that assert the invariant (read " +
  "what each test ACTUALLY asserts — a test named for a rule may only cover a sliver).\n" +
  "- CHECK SCRIPTS: repo scripts wired into the dev/CI flow (config-drift checks, " +
  "design-token checks, codegen-drift checks, custom guards) that exit non-zero on " +
  "violation.\n" +
  "- CI JOBS: pipeline jobs (.github/workflows, .gitlab-ci.yml, etc.) that run any of the " +
  "above on PRs. A check only counts as a CI gate if CI actually runs it on PRs.\n" +
  "- RUNTIME GUARDS: code that enforces the invariant at runtime/write-time (ORM " +
  "interceptors, validation middleware, DB constraints, assertions) so a violation can't " +
  "persist.\n" +
  "- AUDIT JUDGMENT: the `audit` workflow's per-rule judgment pass — SEMI-AUTOMATED, NOT a " +
  "hard CI gate; grade it 'audit'.\n" +
  "If none of these enforce the rule, its enforcement is NONE (reviewer/AI memory only) — " +
  "that is the actionable finding, not a failure to search harder.";

const STRENGTH =
  "STRENGTH grades (assign the STRONGEST enforcement that genuinely applies):\n" +
  "- 'gate'  = a deterministic mechanism FAILS on violation: a static-analysis rule, an " +
  "automated test, a check script, a CI job, or a runtime guard. A violation cannot reach " +
  "the main branch (or cannot be written at runtime).\n" +
  "- 'audit' = only the `audit` judgment pass would catch it. Real, but semi-automated and " +
  "not a hard gate — someone has to run the audit.\n" +
  "- 'none'  = prose only; relies on a human or AI remembering the rule.\n" +
  "Set gap=true unless strength is 'gate'. 'audit' and 'none' are both gaps — the report " +
  "exists to surface them.";

const preamble =
  "You are one agent in a META-AUDIT of a project's harness. You are NOT looking for rule " +
  "violations — you are determining what MECHANISM enforces each rule. Do NOT modify " +
  "files. Use Bash (git/grep), Grep, Glob, and targeted Read, and confirm every claim " +
  "against the actual file before reporting it.";

// ── Schemas ──────────────────────────────────────────────────────────────────
const RULE = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "rule number/name as stated, or a short slug" },
    title: { type: "string", description: "short label" },
    requirement: { type: "string", description: "one sentence: what it mandates" },
  },
  required: ["id", "title", "requirement"],
};

const RULES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rules: { type: "array", items: RULE },
    rulesSource: { type: "string" },
  },
  required: ["rules"],
};

const ENFORCEMENT = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "static-analysis",
        "automated-test",
        "check-script",
        "ci-job",
        "runtime-guard",
        "audit-judgment",
        "none",
      ],
    },
    ref: { type: "string", description: "path / test name / job name / 'none'" },
    note: { type: "string", description: "what it actually asserts/blocks" },
  },
  required: ["type", "ref"],
};

const COVERAGE = {
  type: "object",
  additionalProperties: false,
  properties: {
    ruleId: { type: "string" },
    title: { type: "string" },
    enforcement: { type: "array", items: ENFORCEMENT },
    strength: { type: "string", enum: ["gate", "audit", "none"] },
    gap: { type: "boolean", description: "true unless strength is 'gate'" },
    recommendation: {
      type: "string",
      description: "if gap: how it could be gated, or 'accept as judgment-only'",
    },
  },
  required: ["ruleId", "title", "enforcement", "strength", "gap"],
};

const VERIFY_SCHEMA = {
  ...COVERAGE,
  description: "the corrected coverage after adversarially re-checking each claim",
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", description: "one line: counts by strength" },
    report: { type: "string", description: "markdown coverage matrix + action list" },
    coverage: { type: "array", items: COVERAGE },
  },
  required: ["verdict", "report", "coverage"],
};

// ── Phase 1: enumerate the rules ─────────────────────────────────────────────
phase("Enumerate");
const enumerated = await agent(
  `${preamble}\n\nTASK: read ${rulesFile} (and any sibling rule docs — AGENTS.md, ` +
    "CONTRIBUTING.md, coding-standards) and extract the project's documented " +
    "non-negotiables (numbered lists, 'must/never' statements, documented conventions). " +
    "For each, return { id (number/name/slug), title (short label), requirement (one " +
    "sentence on what it mandates) }. Include EVERY rule, in order — do not merge, " +
    "summarise away, or skip any. Set `rulesSource` to the file(s) used.",
  { label: "enumerate", phase: "Enumerate", schema: RULES_SCHEMA }
);

const rules = (enumerated && enumerated.rules) || [];
if (rules.length === 0) {
  return {
    verdict: `Could not extract any documented rules from ${rulesFile}.`,
    report: `# Rule Coverage\n\nNo documented rules found in ${rulesFile} or its siblings.`,
    coverage: [],
  };
}
log(`${rules.length} rule(s) extracted — mapping each to its enforcement.`);

// ── Phases 2+3: map then verify, pipelined per rule ──────────────────────────
phase("Map");
const verified = await pipeline(
  rules,
  (r) =>
    agent(
      `${preamble}\n\nRULE ${r.id}: ${r.title}\nREQUIREMENT: ${r.requirement}\n\n` +
        SURFACES +
        "\n\n" +
        STRENGTH +
        "\n\nTASK: find every mechanism that genuinely enforces THIS rule and emit an " +
        "enforcement entry { type, ref, note } for each. Then set `strength` to the " +
        "strongest that truly applies, `gap` (true unless 'gate'), and — if gap — a " +
        "one-line `recommendation` (a concrete gate that could enforce it, e.g. an " +
        "analyzer rule, a convention test, or a check script, or 'accept as judgment-only' " +
        "when a hard gate isn't worth it).",
      { label: `map:${r.id}`, phase: "Map", schema: COVERAGE }
    ),
  (mapped, r) => {
    if (!mapped) return null;
    return agent(
      `${preamble}\n\nYou are the VERIFIER for rule ${r.id} (${r.title}).\n` +
        STRENGTH +
        "\n\nAnother agent produced the coverage below. Re-check EACH claimed enforcement " +
        "against the actual file: does that analyzer / test / script / CI job / runtime " +
        "guard REALLY fail when the rule is violated, or is it a nominal or PARTIAL match? " +
        "Classic trap: a check that covers only a sliver of the rule does NOT 'gate' the " +
        "whole rule. Drop overclaims and DOWNGRADE strength when the claimed gate doesn't " +
        "bite end-to-end; default to the LOWER strength when uncertain — an honest " +
        "'audit'/'none' is the whole point. Return the corrected coverage for this rule.\n\n" +
        "CLAIMED:\n" +
        JSON.stringify(mapped, null, 2),
      { label: `verify:${r.id}`, phase: "Verify", schema: VERIFY_SCHEMA }
    );
  }
);

const coverage = verified.filter(Boolean);
if (coverage.length === 0) {
  return {
    verdict: "Mapping produced no coverage entries.",
    report: "# Rule Coverage\n\nNo coverage entries were produced.",
    coverage: [],
  };
}

// ── Phase 4: synthesize the coverage matrix ──────────────────────────────────
phase("Synthesize");
return await agent(
  "Consolidate these verified rule-coverage entries into a harness coverage report. " +
    "Produce three fields. verdict: one line with counts by strength (e.g. 'N gated, M " +
    "audit-only, K unenforced of T rules'). report: a markdown report that LEADS with a " +
    "coverage matrix — a table with columns `Rule | Title | Strength | Mechanism` sorted " +
    "gate → audit → none — FOLLOWED by an '## Action items' section listing every rule " +
    "with gap=true as 'Rule N (title) — <current strength> — <recommendation>'. The " +
    "audit-only and unenforced rules ARE the actionable output; foreground them. coverage: " +
    "the structured list, unchanged. Do not invent rules or re-grade strengths.\n\n" +
    JSON.stringify(coverage, null, 2),
  { label: "synthesize", phase: "Synthesize", schema: REPORT_SCHEMA }
);
