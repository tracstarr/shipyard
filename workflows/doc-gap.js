/**
 * doc-gap — parallel documentation gap analysis for a branch (any repo).
 *
 * A dynamic workflow (https://code.claude.com/docs/en/workflows). Runs in the background
 * and fans across subagents; the caller's context only holds the final structured report.
 *
 * REPORT-ONLY. Never writes docs or touches the worktree — it returns what documentation
 * is missing or stale so the caller (the `deliver-feature` driver skill) can author it in
 * the main loop, in the project's voice, with a human watching.
 *
 * Project-agnostic: each dimension first checks whether the project HAS that convention
 * (a changelog, mirrored rule files, an ADR practice, …) and reports NO gap when it
 * doesn't — it never invents a convention the repo doesn't keep.
 *
 * Dimensions (fan out in one barrier, then a single synthesis agent consolidates):
 *   - changelog       user-visible change ⇒ an entry, IF the project keeps a changelog
 *   - rulefile-sync   a documented rule changed ⇒ every mirrored rule file updated
 *   - topic-doc       feature/architecture doc under the docs tree updated/created
 *   - user-howto      new screen/flow ⇒ user-facing how-to, IF the project has user docs
 *   - api-doc         new endpoints/interfaces carry doc-comments, IF the stack uses them
 *
 * args (global, optional):
 *   { base?: string = "main", rulesFile?: string, projectFacts?: object }
 * Returns: { summary: string, userVisible: boolean, gaps: DocGapEntry[] }
 */

export const meta = {
  name: "doc-gap",
  description:
    "Report-only documentation gap analysis for a branch. Fans out across independent doc dimensions — user-facing changelog, rule-file sync, topic docs, user-facing how-to, and API/interface doc-comments — each gated on whether the project actually keeps that convention, then consolidates into a graded list for the caller to fill.",
  phases: [
    { title: "Analyze", detail: "one agent per doc dimension finds gaps" },
    { title: "Synthesize", detail: "dedupe + grade into one report" },
  ],
};

const A = typeof args === "object" && args ? args : {};
const base = A.base || "main";
const rulesFile = A.rulesFile || "CLAUDE.md";
const facts = A.projectFacts || {};

const factsBlock =
  "PROJECT FACTS (from the caller — CONFIRM against the repo; derive anything missing):\n" +
  JSON.stringify(
    {
      rulesFile,
      changelog: facts.changelog || "(detect: does the repo keep a changelog / release notes?)",
      docsTree: facts.docsTree || "(detect: docs/ or wiki layout, ADRs?)",
      stacks: facts.stacks || "(detect from manifests)",
    },
    null,
    2
  );

const preamble =
  "You are one agent in a parallel DOCUMENTATION audit. You do NOT write or edit any " +
  "file — analysis only. Use Bash (git), Grep, Glob, targeted Read. Diff the branch with " +
  "`git --no-pager diff --name-status $(git merge-base " +
  `${base} HEAD)...HEAD\` and read hunks with ` +
  '`git --no-pager diff $(git merge-base ' +
  `${base} HEAD)...HEAD -- <path>\`. Confirm every claim against the files.\n\n` +
  factsBlock +
  "\n\nFirst rule of this audit: if the project does NOT keep the convention your " +
  "dimension is about, report NO gap and say so in `note`. Never invent a changelog, an " +
  "ADR practice, or a docs page the repo doesn't already maintain.\n\n" +
  "Also report `userVisible`: true if, from what you can see of the diff, this branch " +
  "changes something an end user would notice (a new screen, a visible behavior change, a " +
  "fix they'd feel); otherwise false.";

const DIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: { type: "string" },
    userVisible: {
      type: "boolean",
      description: "does this branch change something an end user would notice",
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["changelog", "rulefile-sync", "topic-doc", "user-howto", "api-doc"],
          },
          path: {
            type: "string",
            description: "doc file to create or edit (proposed path if new)",
          },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          what: { type: "string", description: "what is missing or stale" },
          suggestedAction: { type: "string" },
        },
        required: ["kind", "path", "severity", "what", "suggestedAction"],
      },
    },
    note: { type: "string", description: "verdict / why no gap (incl. 'convention not kept')" },
  },
  required: ["dimension", "userVisible", "gaps"],
};

const DOCGAP_REPORT = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    userVisible: {
      type: "boolean",
      description: "does this branch change something a user would notice",
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          path: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          what: { type: "string" },
          suggestedAction: { type: "string" },
        },
        required: ["kind", "path", "severity", "what", "suggestedAction"],
      },
    },
  },
  required: ["summary", "userVisible", "gaps"],
};

const DIMENSIONS = [
  {
    name: "changelog",
    prompt:
      "DIMENSION: USER-FACING CHANGELOG. First determine whether the project keeps a " +
      "changelog or release-notes surface at all (CHANGELOG.md, a changeset entries dir, " +
      "a 'What's New' page). If it does NOT, report NO gap and note that. If it does: " +
      "decide whether this branch changes something a user would notice (new screen, " +
      "visible behavior change, a fix they'd feel). If yes, check whether a matching entry " +
      "exists (read one existing entry first to match the format/voice). A user-visible " +
      "change with no entry → gap (P1; P0 for a prominent new feature). A purely internal " +
      "change (refactor, infra, test-only, tooling) → NO gap; say so. Most PRs add nothing " +
      "here and that's correct.",
  },
  {
    name: "rulefile-sync",
    prompt:
      "DIMENSION: RULE-FILE SYNC. Determine whether the branch changes a documented " +
      "convention/rule (a new architectural rule, a changed command, a new mechanism). If " +
      "so, every rule file that mirrors the rules must reflect it — many projects keep " +
      "CLAUDE.md and AGENTS.md (and sometimes a CONTRIBUTING/coding-standards doc) in " +
      "sync. Flag: (a) a rule change missing from one or more of those files, or (b) those " +
      "files drifting out of sync on anything this branch touched. If the project has only " +
      "one rule file, or the branch introduces no rule-level change, report NO gap.",
  },
  {
    name: "topic-doc",
    prompt:
      "DIMENSION: TOPIC DOCS. For each meaningful feature/architecture/ops change, identify " +
      "the doc page that should cover it (search the docs tree by feature name). Flag a " +
      "stale page that now contradicts the code, or a substantial new subsystem with no doc " +
      "page at all (propose a path under the right part of the docs tree). If the project " +
      "uses ADRs, a brand-new architectural decision with no ADR is a P1 gap. Skip trivial " +
      "changes that need no doc. If the project keeps no docs tree, report NO gap.",
  },
  {
    name: "user-howto",
    prompt:
      "DIMENSION: USER-FACING HOW-TO. If the branch adds or changes a screen or user " +
      "workflow, check for end-user how-to guidance that tells a user how to USE it — " +
      "distinct from a changelog blurb and from developer docs. Flag missing or outdated " +
      "how-to content. If the change is not user-facing, or the project keeps no user-doc " +
      "surface, report NO gap.",
  },
  {
    name: "api-doc",
    prompt:
      "DIMENSION: API / INTERFACE DOC-COMMENTS. If the stack documents its public surface " +
      "with doc-comments that feed generated docs or a published API spec (e.g. XML docs " +
      "on controllers, JSDoc/TSDoc on exported APIs, docstrings on public functions, " +
      "OpenAPI annotations), confirm new/changed public members carry a meaningful " +
      "(non-boilerplate) doc-comment. Focus on summaries that are missing or unhelpful, not " +
      "on anything a build/lint already enforces. If the stack/project doesn't use this " +
      "convention, or there are no relevant changes, report NO gap.",
  },
];

// ── Phase 1: fan out the independent dimensions (barrier) ────────────────────
phase("Analyze");
const perDim = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(`${preamble}\n\n${d.prompt}`, {
      label: `doc:${d.name}`,
      phase: "Analyze",
      schema: DIM_SCHEMA,
    })
  )
);

// ── Phase 2: synthesize ──────────────────────────────────────────────────────
phase("Synthesize");
const allGaps = perDim.filter(Boolean).flatMap((d) => d.gaps || []);
// Aggregate userVisible deterministically from the dimension agents and enforce it on the
// result below, so the field can't drift from the synthesizer's free-form inference.
const inferredUserVisible = perDim.some((d) => d && d.userVisible === true);
const notes = perDim
  .filter(Boolean)
  .map((d) =>
    `## ${d.dimension}\nuserVisible: ${d.userVisible === true}\n` +
    `${d.note || "(no note)"}\n` +
    (d.gaps && d.gaps.length ? JSON.stringify(d.gaps, null, 2) : "no gaps"))
  .join("\n\n");

if (allGaps.length === 0) {
  return {
    summary: "Documentation is complete for this branch (no gaps found).",
    userVisible: inferredUserVisible,
    gaps: [],
  };
}

const report = await agent(
  "Consolidate these documentation findings into one report. De-dupe and sort P0→P2, and " +
    "lead `summary` with a one-line verdict. Set `userVisible` from the per-dimension " +
    "`userVisible` signals above; the caller also enforces it deterministically.\n\n" +
    notes,
  { label: "synthesize", phase: "Synthesize", schema: DOCGAP_REPORT }
);

// Enforce the deterministic aggregate so the synthesized field can't drift.
return { ...(report || {}), userVisible: inferredUserVisible };
