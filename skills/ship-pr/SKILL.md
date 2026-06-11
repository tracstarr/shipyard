---
name: ship-pr
description: End-to-end "ship this branch" workflow for any repo's PRs — fetch the latest base branch, rebase the current branch, resolve conflicts, open or update the PR, watch CI to green, then triage every unresolved automated-review thread (accept legitimate bugs/quality wins that fit the project's architecture, reject false positives or suggestions that fight the project's documented conventions), applying accepted fixes locally, batching them into one push per review pass, and resolving each thread with an explanatory reply. Use this skill whenever the user wants to "ship my branch", "rebase and push", "babysit this PR", "land this PR", "address the review comments", "resolve the bot's comments", "get CI green", "watch the build", or any phrasing that combines (rebase / push / PR / CI / review comments) with (handle / address / resolve / ship / land / merge-ready). The skill is project-aware at runtime: it learns the project's documented rules (see the discovery contract) and judges each review suggestion against them before deciding accept vs reject — so a suggestion that would introduce a documented anti-pattern is rejected with a citation, while a real null-deref or missing await is accepted, fixed, and resolved. Autonomous by design (the user said "run it and walk away"): it pushes only once per pass, only force-pushes with `--force-with-lease`, and stops to ask only on rebase conflicts it can't safely auto-resolve. Prefer this over ad-hoc `git rebase` + PR-create + comment-reading sequences whenever the user wants the whole loop driven end-to-end. Requires a PR CLI (`gh` for GitHub; `glab` for GitLab) — without one it does the git half and hands the PR step to the user.
---

# Ship PR

Drive a feature branch all the way from "I think I'm done" to "CI green, every review
thread resolved, ready to merge" without the user babysitting each step.

The skill is one continuous loop:

```
1. sync local branch with its remote (fast-forward any commits the remote has that we
   don't — a bot's "commit suggestion" button and human pushes can put commits on the
   remote that aren't local), then rebase onto the base branch
2. ensure a PR exists for this branch (create if missing)
3. push the rebased branch (force-with-lease if rewriting)
4. watch CI to a terminal state
5. fetch every unresolved automated-review thread
6. for each thread: decide accept/reject, apply fix locally if accept
7. ONE push for the whole batch of accepted fixes
8. reply + resolve every thread (accepts and rejects)
9. re-watch CI; if the bot posts new threads after the push, loop to step 5
10. stop when CI is green AND every review thread is resolved
```

The biggest reason this is a skill and not a one-shot script is step 6 — deciding
accept/reject *correctly* requires knowing the project's rules. A naive bot that
auto-applies every suggestion will happily reintroduce the exact anti-patterns the
project's own audits forbid. So this skill does the judgment carefully.

## Step 0a: Discover the project

Learn the repo per **`${CLAUDE_PLUGIN_ROOT}/reference/discover-project.md`**: the
**base/default branch** (the rebase target), the **PR tool** (`gh` / `glab` / none), the
**review bot** (CodeRabbit or another, or none), the **documented rules** (the source of
truth for accept/reject judgment), and the **local gates** (build/test/typecheck) to run
before pushing accepted fixes. If there's **no PR tool**, do the git half (sync, rebase)
and hand the PR/CI/review steps to the user. If there's **no review bot**, run steps 1–4
and stop at green CI (steps 5–9 are about bot threads).

## Why batch fixes into one push per pass

Most review bots re-review on every push. If you push after every accepted fix, the bot
posts a new batch of (often near-duplicate) comments on the in-progress state, the PR fills
with noise, and you chase your own tail. **Apply every accepted fix locally first, then
push once.** The single re-review at the end tells you whether the round closed cleanly.
The exception is the initial rebased push (step 3) — unavoidable, because CI needs the new
tip to run against.

---

## Step 0b: Pre-flight

Run these and read them before doing anything:

```bash
git status --porcelain                                            # working tree
git rev-parse --abbrev-ref HEAD                                   # current branch
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null  # upstream (may not exist)
gh pr view --json number,url,state,headRefName,baseRefName,isDraft 2>/dev/null  # existing PR
```

Stop and ask the user before continuing if:

- The current branch is the base branch (refuse — this skill ships *feature* branches).
- The working tree has uncommitted changes. Offer to commit them with a conventional-commit
  message based on the diff, or `git stash` them with a marker to pop after the rebase.
  Don't silently discard.
- The PR is already `MERGED` or `CLOSED`. Surface that and stop.

Capture: `BRANCH`, `OWNER`/`REPO` (for API calls), `PR_NUMBER` (may be empty until step 2),
`BASE` (default branch).

---

## Step 1: Sync local branch with its remote, then rebase onto the base

**Sync the local branch with its remote first.** A review bot's "commit suggestion" button
(when a human accepts a suggestion in the web UI) pushes a commit directly onto the PR
branch — it lives on the remote but not in any local checkout. A teammate could also push.
If you rebase onto the base without pulling that in, you'll force-push and erase their
commit. This is the single most damaging thing this skill could do, so sync first:

```bash
git fetch origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
MERGE_BASE=$([ -n "$REMOTE" ] && git merge-base HEAD "origin/$BRANCH" || echo "")
```

Branch on the states:

1. **No remote** (`REMOTE` empty) — first push hasn't happened. Continue to the rebase.
2. **Same commit** (`LOCAL == REMOTE`) — nothing to sync. Continue.
3. **Local ahead** (`REMOTE == MERGE_BASE`, `LOCAL != MERGE_BASE`) — local has commits the
   remote doesn't; they'll land in the next push. Continue.
4. **Remote ahead** (`LOCAL == MERGE_BASE`, `REMOTE != MERGE_BASE`) — the remote has commits
   we don't (a bot suggestion or a teammate push). Fast-forward before anything destructive:
   ```bash
   git merge --ff-only "origin/$BRANCH"
   ```
5. **Diverged** (both sides have unique commits) — **stop and ask the user.** Show
   `git log --oneline ${MERGE_BASE}..HEAD` (local-only) and
   `git log --oneline ${MERGE_BASE}..origin/$BRANCH` (remote-only). They decide whether the
   remote-only commits are absorbed or discarded. Never force-push past a diverged remote
   on your own.

Once local matches or leads the remote, rebase onto the base:

```bash
git rebase "origin/$BASE"
```

**If clean**, continue to step 2.

**If conflicts**, you may resolve mechanical ones automatically (import ordering, formatting
drift, lockfile churn, trivially-additive merges where both sides added independent entries
to the same list). For anything semantic — overlapping logic, schema changes touching the
same table, generated-snapshot collisions, design-token redefinitions — stop and ask. Show
the conflicting hunks and your proposed resolution first.

Two situations to handle specially (when the project has them):

- **Generated/migration snapshot conflicts** (ORM model snapshots, generated API specs,
  generated clients). These usually need a *regenerated* artifact, not a hand-merged one.
  Stop and tell the user — don't hand-merge a generated snapshot.
- **Lockfile conflicts** (`package-lock.json`, `Cargo.lock`, `poetry.lock`, …). Resolve by
  taking the incoming base lockfile, then re-running the install so it reflects the merged
  manifest. Stage the result.

After resolving, `git add` and `git rebase --continue`. Loop until done. If a stash was
pushed in step 0b, `git stash pop` now; resolve re-conflicts the same way.

---

## Step 2: Ensure a PR exists

```bash
gh pr view --json number,url,state 2>/dev/null
```

If a PR exists and is `OPEN`, capture `PR_NUMBER` and skip to step 3. Otherwise create one.
Draft the title in the project's conventional-commit style (read `git log --oneline
$BASE..HEAD`) and use the project's PR-body shape (a `## Summary` + `## Test plan` template
is a safe default if the project has none):

```bash
gh pr create --title "<conventional title>" --body "<summary + test plan>"
```

Capture the URL and `PR_NUMBER`. (GitLab: the `glab mr` equivalents.)

---

## Step 3: Push the rebased branch

If the rebase rewrote history (it almost always does), force-push *with lease* — never
plain `--force`:

```bash
git push --force-with-lease
```

First push (no upstream yet): `git push -u origin HEAD`.

`--force-with-lease` refuses to overwrite work someone else pushed in the meantime; plain
`--force` is forbidden by this skill. If the push is rejected because the remote moved,
**don't retry with `--force`** — fetch, inspect what changed (`git log origin/$BRANCH ^HEAD`),
and surface it to the user.

---

## Step 4: Watch CI to a terminal state

```bash
SHA=$(git rev-parse HEAD)
RUN_ID=$(gh run list --branch "$BRANCH" --limit 1 --json databaseId,headSha \
  --jq ".[] | select(.headSha==\"$SHA\") | .databaseId")
gh run watch "$RUN_ID" --exit-status
```

`--exit-status` blocks until the run finishes and exits non-zero on failure — no polling.

**If green**, continue to step 5. **If CI fails**, fetch the failing logs
(`gh run view "$RUN_ID" --log-failed`) and categorize:

- **Real bug introduced by the branch** — fix it (part of the upcoming batched push, not its
  own push).
- **Flaky / infra blip** — re-run once (`gh run rerun "$RUN_ID" --failed`). If it fails
  again, treat as real.
- **Pre-existing failure on the base** — surface to the user; this skill doesn't fix
  unrelated breakage.

Loop step 4 until green or the user intervenes. (GitLab: `glab ci status`/`glab ci view`.)

---

## Step 5: Fetch unresolved review-bot threads

This step is GitHub-specific via `gh api graphql`. The review bot posts as a bot account
(e.g. `coderabbitai[bot]`). Threads — not individual comments — are the unit of "resolved
or not", so use the `reviewThreads` API:

> **Limitation:** the query fetches up to 100 threads and 20 comments/thread; pagination
> isn't implemented. For PRs with very many threads, fall back to manual review.

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes {
          id isResolved isOutdated path line
          comments(first:20) { nodes { databaseId author { login } body path line diffHunk } }
        }
      }
    }
  }
}' -F owner="$OWNER" -F repo="$REPO" -F pr="$PR_NUMBER" > /tmp/review-threads.json
```

Filter to threads where `isResolved` is false AND `isOutdated` is false AND at least one
comment author is the review bot. For each, capture `threadId`, root `comment.databaseId`,
`path`, `line`, and the comment `body`.

If there are zero unresolved bot threads and CI is green, the skill is done — report a
one-line summary and stop.

---

## Step 6: Triage each thread (the judgment step)

For each unresolved thread, decide **accept** or **reject** — autonomously, per the
project's rules. There is no "ask the user" fallback for borderline cases here; the point
is to run the loop hands-off. Read the relevant file and surrounding code before deciding
— the suggestion's diff hunk isn't always enough context.

### Default to accept if any are true

- It identifies a **real bug**: null deref, missing `await`, off-by-one, swapped args,
  injection, undisposed resource, race, wrong status code, broken serialization, broken
  nullability, broken regex/date math, broken path handling, wrong auth check.
- It catches a **real violation of a documented project rule** (the ones you captured in
  discovery): a missing authorization check, a missing required attribute/annotation, a
  forbidden pattern the project's own audit would flag.
- It's a **small quality win** that doesn't fight any project rule: extracting a magic
  number, collapsing duplicated logic, removing dead code, fixing a typo in a user-visible
  string, improving an error message.

### Default to reject if any are true

- It **conflicts with a documented project rule** — cite the rule (file + name/number) in
  the reply. (A suggestion to reintroduce a pattern the project explicitly forbids → reject
  with the citation.)
- It's a **pure stylistic preference** fighting the established codebase style (the project's
  formatter/linter already enforces what matters).
- It's a **false positive** — the "bug" isn't one once you read the file (the value *is*
  null-checked the line above; the `await` *is* there; the capability *is* registered).
- It's a **speculative refactor** beyond this PR's scope ("extract a service", "convert to
  async", "split this file") — out of scope.
- It proposes a **comment** explaining code already obvious from naming, or **error handling
  for scenarios that can't happen** (defensive checks on framework-guaranteed non-null).

### Borderline calls

Lean *accept* if the fix is small and reversible; *reject* if it would expand the diff
materially. A small wrong accept is easy to revert; a large speculative refactor absorbed at
review time is not. When uncertain, write the rejection so it invites pushback: "Holding on
this — [reason]. Happy to revisit if you disagree."

### Build the action lists

```
ACCEPTS = [ { thread_id, root_comment_id, path, line, fix_description, reply_body } … ]
REJECTS = [ { thread_id, root_comment_id, reply_body } … ]
```

Accept reply: `Done in <sha-after-push>. <one-line summary of the fix>.` (the sha is filled
in after step 7 — don't post replies before the push). Reject reply: `Skipping this —
<one-line reason>. <citation: rule name/number, or the file:line that already handles it,
or "out of scope for this PR">.` Keep replies short and concrete. No emojis. Don't apologize.

---

## Step 7: Apply every accepted fix locally, then ONE push

Go through `ACCEPTS` and edit files (use `Edit`, not raw patches). For each: read the file
at the line range, apply the **minimal** fix that closes the thread (no "while I'm here"
refactors). After all accepted fixes:

1. Run the relevant **local gates** (the detected build / typecheck / targeted tests for the
   files you touched). They must pass — if the project treats warnings as errors, a single
   warning fails. If a generated artifact or migration was touched, surface it to the user;
   those should almost never appear in a review-driven fix pass.
2. Commit with conventional-commit grouping: trivial nits batch into one
   `chore: address review feedback` commit; substantive fixes each get a focused commit
   (`fix(auth): null-check before claim lookup`) so they read cleanly in `git log`. Don't
   paste bot comment URLs into messages — they go stale.
3. Push **once** for the whole batch: `git push --force-with-lease`.
4. Capture the new short SHA — every accept reply needs it: `NEW_SHA=$(git rev-parse --short HEAD)`.

If `ACCEPTS` is empty (all rejects), there's no push — skip to step 8 with the existing
HEAD sha as `NEW_SHA`.

---

## Step 8: Reply and resolve every thread

For each pending thread (accepts and rejects), two calls. **Reply** (as a child of the
thread), then **resolve** — reply first so the resolution has rationale attached:

```bash
gh api repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments/$ROOT_COMMENT_ID/replies -f body="$REPLY_BODY"
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}' -F threadId="$THREAD_ID"
```

Verify the mutation returned `isResolved: true`; if false, log it and continue — don't loop
forever on one broken thread. Run sequentially per thread (reply, resolve, next) — don't
parallelize; the review API is fussy about concurrent writes and the synchronous cost is
negligible next to CI.

---

## Step 9: Wait for post-push CI, then re-check for new threads

If step 7 pushed, CI is running again — loop back to step 4 and watch it to green (fixes can
break CI too). Then refetch unresolved bot threads (step 5). Three outcomes:

- **Zero unresolved threads** — done, go to step 10.
- **New threads appeared** (the bot found follow-ons) — loop to step 6. Usually converges in
  one or two extra passes.
- **Same threads still unresolved** — the resolve mutations failed silently (rare) or the bot
  reopened them. Read them; if the bot pushed back on a reject with new context, re-judge. If
  it's still a reject, leave it for the human reviewer and report it.

Bound the loop to **at most 3 full passes** through the bot. If it hasn't converged in 3,
stop and report the state so the user can intervene.

---

## Step 10: Report and stop

```
PR #<number> — CI green at <sha>. <N> review thread(s) handled: <A> accepted, <B> rejected.
<Y> push(es). Ready for human review.
```

If the skill couldn't fully close out (CI broken, judgment stalemate, rebase conflict it
bounced off), say so directly and list what's left.

---

## Things this skill must not do

- **Never use plain `git push --force`.** Always `--force-with-lease`.
- **Never skip hooks** (`--no-verify`). If a pre-commit hook fails, the problem is real — fix it.
- **Never amend an existing commit** to absorb review fixes — bots anchor comments to commits;
  amending breaks the thread context. Always create new commits.
- **Never resolve a thread without replying first.** A resolved thread with no rationale reads
  as "ignored."
- **Never accept a suggestion that introduces a documented rule violation.** Cite the rule and
  reject — the project's own audit gate would fail it anyway.
- **Never push between accepts within the same pass.** Batch them.
- **Never delete or close threads** (`unresolveReviewThread`, `deleteReviewComment`) — only
  *resolve*. Reopening/deleting belongs to humans.
- **Never merge the PR.** The skill leaves it review-ready; merging is a human decision.

## Tone of replies

The audience for your reply is the human reviewer who scans the thread next. Replies should
be short, concrete, useful at-a-glance — not chatty, not apologetic, not over-justified.

Good: *"Skipping this — the project forbids role-based checks (CONTRIBUTING §auth); we
authorize on capabilities. The attribute on line 42 already gates this."* /
*"Done in `a3f9b21`. Added the missing 404 branch — same shape as the sibling action below."*

Bad: *"Great catch! I'll fix this right away! 🚀"* / *"I respectfully disagree because the
implementation already handles this through a different mechanism that I'll now explain in
detail…"*

## When this skill is the wrong tool

- **PR not yet at "code complete".** If the user is still iterating, don't ship — they want
  feedback, not closure.
- **First-time-deploy migration changes** needing staging verification first. The skill
  rebases and pushes; it doesn't know about staging promotion.
- **Cross-team PRs** where the user isn't the sole decider on review accepts/rejects — defer
  to humans.
- **PRs against a non-default base** (release branch, stacked PR). The skill rebases onto the
  default base; if the base is something else, stop and ask.
