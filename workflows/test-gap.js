/**
 * test-gap — parallel test-coverage gap analysis for a branch (any repo).
 *
 * A dynamic workflow (https://code.claude.com/docs/en/workflows). The runtime runs this
 * in the background and fans the work across subagents, so the caller's context only ever
 * holds the final structured gap report.
 *
 * REPORT-ONLY. This workflow never writes tests or touches the worktree — it returns a
 * list of missing unit/integration/e2e coverage for the caller (the `deliver-feature`
 * driver skill) to fill back in the main loop, where a human is watching. Identifying
 * gaps fans out well; writing the tests belongs in one coherent, reviewable context.
 *
 * Project-agnostic: it learns the project's test frameworks and layout from the repo
 * (and from `args.projectFacts`, which the caller passes after discovery) rather than
 * hardcoding any one stack.
 *
 * Shape:
 *   Phase 1  Scope       — one agent buckets the diff into testable surfaces
 *   Phase 2  Analyze     — per surface: find which layers are uncovered ...
 *   Phase 3  Verify      — ... then adversarially confirm the test is REALLY absent
 *                          (pipelined: a surface verifies as soon as its analysis lands)
 *   Phase 4  Synthesize  — one agent dedupes + grades into a single report
 *
 * args (global, optional):
 *   { base?: string = "main",
 *     projectFacts?: object }   // { stacks, testCmd, testLayers, frameworks, ... }
 *
 * Returns: { summary: string, gaps: GapEntry[] } (see TESTGAP_REPORT below).
 */

export const meta = {
  name: "test-gap",
  description:
    "Report-only test-coverage gap analysis for a branch. Buckets the diff into testable surfaces, fans out one agent per surface to find missing unit/integration/e2e coverage, adversarially verifies each gap, and returns a graded, deduped list for the caller to fill. Learns the project's test frameworks at runtime.",
  phases: [
    { title: "Scope", detail: "bucket the branch diff into testable surfaces" },
    { title: "Analyze", detail: "one agent per surface finds uncovered layers" },
    { title: "Verify", detail: "adversarially confirm each gap is really absent" },
    { title: "Synthesize", detail: "dedupe + grade into one report" },
  ],
};

const A = typeof args === "object" && args ? args : {};
const base = A.base || "main";
const facts = A.projectFacts || {};

const factsBlock =
  "PROJECT FACTS (provided by the caller after discovery — CONFIRM against the repo, " +
  "and if a field is missing, derive it yourself by reading the test config and " +
  "existing test files):\n" +
  JSON.stringify(
    {
      stacks: facts.stacks || "(detect from manifests)",
      testCmd: facts.testCmd || "(detect from package manifest / Makefile)",
      testLayers: facts.testLayers || "(detect: unit / integration / e2e)",
      frameworks: facts.frameworks || "(detect per layer)",
    },
    null,
    2
  );

const TEST_FACTS =
  "Test-layer conventions to apply (confirm against THIS repo, don't assume a stack):\n" +
  "- UNIT: fast, in-process, no external services. Framework + location vary by stack " +
  "(xUnit/NUnit, vitest/jest, pytest, go test, cargo test, rspec, JUnit). Co-located or " +
  "in a dedicated test project/dir.\n" +
  "- INTEGRATION: exercises a real boundary (DB, HTTP host, queue). Often tagged/marked " +
  "and run separately; may need infra up.\n" +
  "- E2E: drives the running app through its real entrypoint (browser via Playwright/" +
  "Cypress, or a black-box CLI/API run). This is the layer for cross-screen / " +
  "authorization-gated user flows.\n" +
  "Map each changed surface to the layers that SHOULD cover it, using whatever frameworks " +
  "the repo actually uses.";

const preamble =
  "You are one agent in a parallel TEST-COVERAGE audit. You do NOT write tests or modify " +
  "any file — analysis only. Use Bash (git), Grep, Glob, and targeted Read. Confirm every " +
  "claim against the actual files before reporting it.\n\n" +
  factsBlock +
  "\n\n" +
  TEST_FACTS;

// ── Schemas ────────────────────────────────────────────────────────────────
const SURFACE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    surfaces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "short human label" },
          kind: {
            type: "string",
            enum: [
              "backend-endpoint",
              "backend-service",
              "backend-job",
              "backend-entity-or-migration",
              "backend-other",
              "frontend-component",
              "frontend-hook-or-util",
              "frontend-feature-flow",
              "cli-or-script",
              "other",
            ],
          },
          files: { type: "array", items: { type: "string" } },
          expectedLayers: {
            type: "array",
            items: { type: "string", enum: ["unit", "integration", "e2e"] },
            description: "test layers that SHOULD cover this surface",
          },
        },
        required: ["name", "kind", "files", "expectedLayers"],
      },
    },
  },
  required: ["surfaces"],
};

const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    surface: { type: "string" },
    existingCoverageNote: { type: "string" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          layer: { type: "string", enum: ["unit", "integration", "e2e"] },
          file: { type: "string", description: "production file lacking coverage" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          what: { type: "string", description: "what behavior is untested" },
          suggestedTest: { type: "string" },
          suggestedTestPath: { type: "string" },
        },
        required: ["layer", "file", "severity", "what", "suggestedTest"],
      },
    },
  },
  required: ["surface", "gaps"],
};

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    surface: { type: "string" },
    confirmedGaps: { type: "array", items: ANALYZE_SCHEMA.properties.gaps.items },
    droppedCount: { type: "integer" },
    droppedReason: { type: "string" },
  },
  required: ["surface", "confirmedGaps", "droppedCount"],
};

const TESTGAP_REPORT = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "one-line verdict" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          surface: { type: "string" },
          layer: { type: "string", enum: ["unit", "integration", "e2e"] },
          file: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          what: { type: "string" },
          suggestedTest: { type: "string" },
          suggestedTestPath: { type: "string" },
        },
        required: ["surface", "layer", "file", "severity", "what", "suggestedTest"],
      },
    },
  },
  required: ["summary", "gaps"],
};

// ── Phase 1: scope ───────────────────────────────────────────────────────────
phase("Scope");
const scope = await agent(
  `${preamble}\n\nTASK: bucket the branch diff into testable surfaces. Run ` +
    "`git --no-pager diff --name-status $(git merge-base " +
    `${base} HEAD)...HEAD\` to list changed files (added/modified only; ignore pure ` +
    "deletions and pure-doc/spec changes). Group them into coherent surfaces and, for " +
    "each, decide which test LAYERS should cover it: an endpoint/handler → integration " +
    "(in-process host) + often e2e; a service/business rule → unit (+ integration if it " +
    "touches a real boundary); a job/scheduled task → integration; an entity/migration → " +
    "integration (round-trip / convention); a UI component → unit; a user-visible flow " +
    "across screens → e2e; a hook/util/CLI → unit. Return the surfaces.",
  { label: "scope", phase: "Scope", schema: SURFACE_SCHEMA }
);

const surfaces = (scope && scope.surfaces) || [];
if (surfaces.length === 0) {
  return { summary: "No testable surfaces changed on this branch.", gaps: [] };
}
log(`${surfaces.length} surface(s) to analyze for coverage gaps.`);

// ── Phases 2+3: analyze then verify, pipelined per surface ───────────────────
phase("Analyze");
const verified = await pipeline(
  surfaces,
  (s) =>
    agent(
      `${preamble}\n\nSURFACE: ${s.name} (${s.kind})\nFILES:\n` +
        s.files.map((f) => `- ${f}`).join("\n") +
        `\nEXPECTED TEST LAYERS: ${s.expectedLayers.join(", ")}\n\n` +
        "TASK: for each expected layer, determine whether tests covering this surface's " +
        "NEW or CHANGED behavior already exist. Search the test projects/dirs by symbol " +
        "name, route, component name, and file path. Report a gap ONLY for behavior that " +
        "is genuinely untested. Grade P0 (core/security path with zero coverage), P1 " +
        "(meaningful branch untested), P2 (edge case / nice-to-have). Note any coverage " +
        "you DID find so the verifier can double-check.",
      { label: `analyze:${s.name}`, phase: "Analyze", schema: ANALYZE_SCHEMA }
    ),
  (analysis, s) => {
    if (!analysis || !analysis.gaps || analysis.gaps.length === 0) {
      return { surface: s.name, confirmedGaps: [], droppedCount: 0 };
    }
    return agent(
      `${preamble}\n\nYou are the VERIFIER. For surface "${s.name}", another agent ` +
        "reported these coverage gaps. Your job is to REFUTE each one: search harder for " +
        "an existing test (different file, parametrized case, shared fixture, e2e step) " +
        "that already covers the behavior. DROP any gap you can disprove. Keep only gaps " +
        "you independently confirm are real. Default to dropping when uncertain — a false " +
        "'missing test' wastes the caller's time.\n\nREPORTED GAPS:\n" +
        JSON.stringify(analysis.gaps, null, 2),
      { label: `verify:${s.name}`, phase: "Verify", schema: VERIFY_SCHEMA }
    );
  }
);

// ── Phase 4: synthesize ──────────────────────────────────────────────────────
phase("Synthesize");
const confirmed = verified
  .filter(Boolean)
  .flatMap((v) =>
    (v.confirmedGaps || []).map((g) => ({ surface: v.surface, ...g }))
  );

if (confirmed.length === 0) {
  return {
    summary: "All changed surfaces have adequate unit/integration/e2e coverage.",
    gaps: [],
  };
}

return await agent(
  "Consolidate these verified test-coverage gaps into one report. De-dupe overlaps, sort " +
    "P0→P2, and keep each gap's surface/layer/file/suggestedTest. Lead `summary` with a " +
    `one-line verdict (e.g. "${confirmed.length} confirmed gaps: N unit, M integration, ` +
    'K e2e").\n\n' +
    JSON.stringify(confirmed, null, 2),
  { label: "synthesize", phase: "Synthesize", schema: TESTGAP_REPORT }
);
