/**
 * audit — parallel, multi-domain branch audit against the PROJECT'S OWN rules (any repo).
 *
 * A dynamic workflow (https://code.claude.com/docs/en/workflows): the runtime runs this in
 * the background and fans the work across subagents, so the caller's context only ever
 * holds the final graded report.
 *
 * REPORT-ONLY. No agent modifies files — every finding is confirmed with a targeted Read
 * first, so the report stays free of false positives.
 *
 * Project-agnostic: instead of hardcoding one project's rules, Phase 0 READS the project's
 * rule file(s) and clusters the documented non-negotiables into a fixed set of generic
 * domains. The per-domain audit agents then check the diff against THOSE rules. If the
 * project documents no rules, the enumerate agent infers conventions from the code plus
 * general best practice, and the report says the rule set was inferred.
 *
 * Shape:
 *   Phase 0  Enumerate    — one agent reads the rule file and clusters rules into domains
 *   Phase 1  Audit        — one agent per non-empty domain audits the diff IN PARALLEL
 *   Phase 2  Cross-check  — one agent re-tests each finding, drops false positives, dedupes
 *   Phase 3  Synthesis    — one agent emits a P0–P3 report with path:line refs
 *
 * args (global, optional):
 *   { base?: string = "main",
 *     rulesFile?: string = "CLAUDE.md",
 *     severityFloor?: "P0"|"P1"|"P2"|"P3" = "P3",
 *     repoWide?: boolean = false,
 *     projectFacts?: object }
 *
 * Returns: { verdict: string, report: string (markdown), findings: Finding[] }
 */

export const meta = {
  name: "audit",
  description:
    "Report-only, parallel branch audit against the project's own documented rules. Reads the rule file, clusters its non-negotiables into domains, fans out one agent per domain, adversarially cross-checks every finding to drop false positives, then synthesizes a graded P0–P3 report with path:line references. Diff-scoped by default; repoWide sweeps invariants repo-wide.",
  phases: [
    { title: "Enumerate", detail: "read the rule file, cluster rules into domains" },
    { title: "Audit", detail: "one agent per domain audits the diff in parallel" },
    { title: "Cross-check", detail: "re-test findings, drop false positives, de-dupe" },
    { title: "Synthesis", detail: "graded P0–P3 report with path:line refs" },
  ],
};

const A = typeof args === "object" && args ? args : {};
const base = A.base || "main";
const rulesFile = A.rulesFile || "CLAUDE.md";
const severityFloor = A.severityFloor || "P3";
const repoWide = A.repoWide || false;

const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const floorRank = RANK[severityFloor] != null ? RANK[severityFloor] : 3;
const atOrAbove = (f) => (RANK[f.severity] != null ? RANK[f.severity] : 3) <= floorRank;

// The fixed generic domain catalog. The enumerate agent maps the project's documented
// rules into these buckets; empty buckets are skipped in the Audit phase.
const DOMAIN_CATALOG = [
  {
    key: "authz-security",
    blurb:
      "authentication, authorization (roles/capabilities/permissions), tenancy isolation, " +
      "secrets handling, injection, crypto, SSRF/CSRF, anything security-sensitive.",
  },
  {
    key: "data-persistence",
    blurb:
      "schema & migrations, ORM/query usage, transactions, data integrity & immutability, " +
      "audit trails, soft-delete policy, caching coherence.",
  },
  {
    key: "api-interface",
    blurb:
      "endpoint/handler conventions, request/response shapes & DTOs, status codes, error " +
      "shapes, versioning, the public/exported interface surface, naming/structure rules.",
  },
  {
    key: "frontend-ui",
    blurb:
      "design tokens/theming, responsive & accessibility rules, generated-client usage, " +
      "component/state conventions, i18n — only if the project has a frontend.",
  },
  {
    key: "hygiene-config-docs",
    blurb:
      "no committed secrets, config-drift propagation, no checked-in plan/review artifacts, " +
      "conventional commits, rule-file/doc sync, feature-flag conventions, dependency hygiene.",
  },
  {
    key: "other",
    blurb: "any documented non-negotiable that doesn't fit the buckets above.",
  },
];

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

const ENUMERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rulesSource: {
      type: "string",
      description: "the file(s) the rules came from, or 'inferred from code + best practice'",
    },
    domains: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: {
            type: "string",
            enum: DOMAIN_CATALOG.map((d) => d.key),
          },
          rules: { type: "array", items: RULE },
        },
        required: ["key", "rules"],
      },
    },
  },
  required: ["domains"],
};

const FINDING = {
  type: "object",
  additionalProperties: false,
  properties: {
    domain: { type: "string" },
    path: { type: "string" },
    line: { type: "integer", description: "1-based line, if known" },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    rule: { type: "string", description: "the project rule it breaks (id/title)" },
    what: { type: "string", description: "what is wrong" },
    fix: { type: "string", description: "suggested fix direction" },
  },
  required: ["path", "severity", "rule", "what", "fix"],
};

const FINDING_WITH_DOMAIN = { ...FINDING, required: [...FINDING.required, "domain"] };

const DOMAIN_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: { type: "array", items: FINDING },
    verdict: { type: "string", description: "one-sentence domain verdict" },
  },
  required: ["findings", "verdict"],
};

const CROSSCHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    survivingFindings: { type: "array", items: FINDING_WITH_DOMAIN },
    droppedCount: { type: "integer" },
    notes: { type: "string" },
  },
  required: ["survivingFindings", "droppedCount"],
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", description: "one line: clean vs N findings" },
    report: { type: "string", description: "markdown report, grouped P0→P3" },
    findings: { type: "array", items: FINDING_WITH_DOMAIN },
  },
  required: ["verdict", "report", "findings"],
};

// ── Per-domain audit preamble ────────────────────────────────────────────────
const scopeNote = repoWide
  ? "Audit these rules REPO-WIDE (invariant sweep), not just the diff."
  : "Audit ONLY the files changed on the current branch vs `" + base + "`. List them with " +
    "`git --no-pager diff --name-status $(git merge-base " + base + " HEAD)...HEAD` and " +
    "read hunks with `git --no-pager diff $(git merge-base " + base + " HEAD)...HEAD -- " +
    "<path>`. If no files relevant to your rules changed, return an empty findings array " +
    "and a 'no relevant changes' verdict.";

const auditPreamble =
  "You are ONE domain agent in a parallel code-audit fan-out. Do NOT modify files — report " +
  "only. Use Bash (git), Grep, Glob, and targeted Read. CONFIRM every violation with a " +
  "targeted Read before reporting it — no false positives. " + scopeNote + "\n\n" +
  "You will be given the PROJECT'S OWN rules for your domain. Audit the changed code " +
  "against EACH of those rules. For every CONFIRMED violation emit a finding (path, line " +
  "if known, severity, the project rule it breaks, what's wrong, fix direction). If a rule " +
  "holds, add nothing for it. Grade severity: P0 = build/security breaker, P1 = " +
  "correctness, P2 = convention, P3 = nit. End with a one-sentence domain verdict.";

// ── Phase 0: enumerate + cluster the project's rules ─────────────────────────
phase("Enumerate");
const enumerated = await agent(
  "You are the rule-enumeration pass of a code audit. Do NOT modify files. Use Read/Grep/" +
    "Glob.\n\nTASK: read the project's rule file(s) — start with `" + rulesFile + "`, and " +
    "also check AGENTS.md, CONTRIBUTING.md, and any coding-standards / rules docs — and " +
    "extract the project's NON-NEGOTIABLE rules (numbered lists, 'must/never' statements, " +
    "documented conventions). Assign EACH rule to exactly one of these domains:\n" +
    DOMAIN_CATALOG.map((d) => `- ${d.key}: ${d.blurb}`).join("\n") +
    "\n\nReturn `domains` as an array of { key, rules: [{id,title,requirement}] }, omitting " +
    "domains that have no rules. Set `rulesSource` to the file(s) you used. If the project " +
    "documents NO rules anywhere, infer a small set of sensible conventions from the code " +
    "and general best practice, cluster those, and set `rulesSource` to 'inferred from " +
    "code + best practice'.",
  { label: "enumerate", phase: "Enumerate", schema: ENUMERATE_SCHEMA }
);

const domains = ((enumerated && enumerated.domains) || []).filter(
  (d) => d && Array.isArray(d.rules) && d.rules.length > 0
);
const rulesSource = (enumerated && enumerated.rulesSource) || rulesFile;

if (domains.length === 0) {
  return {
    verdict: "No auditable rules could be enumerated for this project.",
    report: "# Code Audit\n\nNo rules were found or inferred, so nothing was audited.",
    findings: [],
  };
}
log(
  `${domains.length} rule domain(s) from ${rulesSource}: ` +
    domains.map((d) => `${d.key}(${d.rules.length})`).join(", ")
);

// ── Phase 1: the per-domain audit, in parallel ───────────────────────────────
phase("Audit");
const domainResults = await parallel(
  domains.map((d) => () =>
    agent(
      `${auditPreamble}\n\nDOMAIN: ${d.key}\nPROJECT RULES FOR THIS DOMAIN:\n` +
        d.rules
          .map((r) => `- [${r.id}] ${r.title}: ${r.requirement}`)
          .join("\n"),
      { label: `audit:${d.key}`, phase: "Audit", schema: DOMAIN_RESULT_SCHEMA }
    )
  )
);

// Attribute findings by index (robust to a skipped/null agent); don't trust the agent to
// echo its own domain key.
const rawFindings = domainResults.flatMap((r, i) =>
  r && Array.isArray(r.findings)
    ? r.findings.map((f) => ({ ...f, domain: domains[i].key }))
    : []
);

if (rawFindings.length === 0) {
  return {
    verdict: `Clean — no violations found across ${domains.length} rule domain(s).`,
    report:
      "# Code Audit\n\n**Clean** — no violations found across: " +
      domains.map((d) => d.key).join(", ") +
      `.\n\n_Rules source: ${rulesSource}._`,
    findings: [],
  };
}
log(`${rawFindings.length} raw finding(s) — cross-checking.`);

// ── Phase 2: adversarial cross-check ─────────────────────────────────────────
phase("Cross-check");
const cross = await agent(
  "You are the verification pass of a code audit. Below are per-domain findings, each " +
    "citing a project rule. Re-test each one against the rule it cites by reading the " +
    "referenced path:line; DROP any that are false positives or covered by a documented " +
    "exemption, and DE-DUPE overlapping findings. Return only the survivors, each still " +
    "tagged with its domain, rule, and severity. Default to dropping when you cannot " +
    "confirm the violation.\n\n" +
    JSON.stringify(rawFindings, null, 2),
  { label: "crosscheck", phase: "Cross-check", schema: CROSSCHECK_SCHEMA }
);

const survivors = ((cross && cross.survivingFindings) || []).filter(atOrAbove);

if (survivors.length === 0) {
  return {
    verdict: `Clean — no findings at or above ${severityFloor} after cross-check.`,
    report:
      "# Code Audit\n\n**Clean** — all raw findings were dropped as false positives/exempt, " +
      `or fell below the ${severityFloor} floor.\n\n_Rules source: ${rulesSource}._`,
    findings: [],
  };
}

// ── Phase 3: synthesis ───────────────────────────────────────────────────────
phase("Synthesis");
return await agent(
  "Synthesize the verified audit findings below into a report. They are already graded P0 " +
    "(build/security breaker), P1 (correctness), P2 (convention), P3 (nit), and already " +
    "filtered to at or above " + severityFloor + ". Produce three fields. verdict: one " +
    "line summarizing the finding count by severity. report: a markdown report grouping " +
    "findings by severity (P0, then P1, then P2, then P3), each line formatted as " +
    `'path:line - (<rule>) - what - fix', and noting the rules source (${rulesSource}). ` +
    "findings: the structured list, unchanged. Do not invent or re-grade findings.\n\n" +
    JSON.stringify(survivors, null, 2),
  { label: "synthesis", phase: "Synthesis", schema: REPORT_SCHEMA }
);
