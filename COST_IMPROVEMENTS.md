# Chat Agent — Token Cost Improvements

Tracking document for ongoing cost-reduction work on the chat agent flow
(`orchestrator/{plan,execute,synthesize,context}.ts`).

Phases 1 and 2 have shipped. Phases 3–4 are queued.

---

## ✅ Phase 1 — Shipped

Quick wins. Estimated 60–70% cost reduction on the average chat turn.

| # | Change | File | Notes |
|---|--------|------|-------|
| 1 | Scope Notion catalog to `agent.notionScope` (was: full workspace on every turn) | `orchestrator/plan.ts` | Honors design doc; was a bug |
| 2 | Lower `MAX_TOTAL_INPUT_CHARS` 150K → 30K, cap to 5 pages, per-page 20K → 12K | `orchestrator/context.ts` | Compression input ~5× smaller |
| 3 | Anthropic prompt caching on every system prompt (planner, page-selector, context compressor, executors, synthesis) | `lib/llm-cache.ts` (new) + all orchestrator files | Caching itself was a no-op below the 1024/2048-token thresholds — see Phase 2 cleanup |
| 4 | Drop the dual-reviewer default; pick `content-validator` OR `cmo-reviewer`, not both | `prisma/agents/managers/index.ts` (CMO) | Re-run `pnpm db:seed` to apply |
| 5 | Bound conversation history: last 12 messages / 4K tokens, DONE-only, with cache breakpoint on the last message | `lib/conversation-history.ts` (new), `orchestrator/plan.ts` | Stops linear cost growth on long threads |

**Outcome:** average per-turn cost dropped to ~$0.20 (from ~$0.50). Most of
the remaining cost was concentrated in (a) over-long executor plans, (b)
unnecessary Sonnet synthesis calls on polish/draft requests, (c) the planner
itself running on Sonnet.

---

## ✅ Phase 2 — Shipped

Target: collapse plan length, skip synthesis when the executor already
produced the deliverable, and right-size the planner.

| # | Change | File | Notes |
|---|--------|------|-------|
| A | Surgical rewrite of every manager prompt (CEO/CPO/CMO/CTO/CFO/CLO): renamed "Standard plan shapes" → "Maximum plan shapes (do less by default)", added 2–3 worked examples per manager (1-step minimum, full pipeline), made the plan-length discipline the first thing the model reads | `prisma/agents/managers/index.ts` | Re-run `pnpm db:seed` |
| B | Added `synthesisRequired: boolean` to `ExecutionPlanSchema`. When the planner sets it `false`, synthesis is replaced with a tiny Haiku formatter pass that strips executor artifacts (preambles, "Assumptions:" blocks) and ships the executor output verbatim. Conservative heuristic skips even the formatter call when the output is already clean | `orchestrator/plan.ts`, `orchestrator/synthesize.ts`, `prisma/schema.prisma` | DB migration required: `synthesisRequired Boolean @default(true)` |
| D | Cache restructure for shared-prefix reuse. Both planner AND executor calls now use a multi-block system: `[notion_context, BP][persona/instructions, BP]` with notion FIRST. Within a single plan, every executor that opts into `{{notionContext}}` shares the same cached prefix → executors 2..N hit the cache on the ~1.5K-token notion block. Notion context is removed from the prompt body when injected via cached system to avoid double-paying for it | `orchestrator/{plan,execute}.ts` | Cross-executor cache hits within a plan are the biggest single win |
| E | ~~Planner Sonnet → Haiku flip~~ — **reverted same session**. The decision-log entry below explains why. Planner stays on `agent.model` (Sonnet). | `orchestrator/plan.ts` | See decision log: "Planner stays on Sonnet" |
| F | Removed no-op `cachedSystem()` calls from page selector, context compressor, and executor — system prompts are 150–500 tokens, well below Anthropic's 1024 / 2048-token cache minimums, so the breakpoint was silently ignored anyway. Code is simpler now | `orchestrator/{plan,context,execute}.ts` | Cleanup, not a savings change |

**Estimated combined impact:** plan length should drop to 1–2 steps for the
majority of turns (down from 3–4); ~40% of turns skip synthesis entirely
(saves ~$0.04 each). Planner stays on Sonnet (see decision log).

**To activate Phase 2:**
1. Run the DB migration to add `synthesisRequired`:
   `pnpm prisma migrate dev --name add_synthesis_required`
2. Run `pnpm db:seed` so the updated manager prompts reach the database.
3. Restart workers.

**Decisions logged:**
- Synthesis-skip behaviour: tiny Haiku formatter pass instead of raw
  publish. ~$0.003 vs $0.04 for Sonnet synthesis. Keeps a safety net for
  executor preambles without paying full price.
- Manager prompt rewrite: surgical (kept structure, added examples)
  rather than full rewrite. Lower risk of behaviour regressions.
- Planner Haiku flip: shipped without prior feedback-analyzer
  verification, on the bet that structured-output classification is well
  within Haiku's range. Easy revert via the `PLANNER_MODEL` constant.

---

## 📋 Phase 3 — Notion phase skip and synthesis input compression

Target: cut another 15–25% by skipping unnecessary work entirely.

### #3 Skip the Notion phase when not needed
**Problem:** Every chat turn still fires two Haiku calls (page selection +
compression) even when the user's message is self-contained ("polish this
tweet I'm pasting", "what's 2+2?").
**Approach:** Combine `needsContext: boolean` into the existing page-selector
schema. When the model returns `false`, skip the compressor entirely
(saves the expensive ~30K-input compression call).
**Estimated saving:** ~$0.025 + ~2s latency on a large fraction of turns.

### #7 Stop duplicating `{{notionContext}}` across executor steps
**Problem:** The full Notion context block is injected into the planner's
message stream AND re-injected into every step that uses `{{notionContext}}`.
For multi-step plans, the same 1.5K token blob is paid 2–4×.
**Approach:** Inject `{{notionContext}}` only into the *first* executor step
that requests it. Downstream steps reference `{{steps[0].output}}` if they
need the brand context to flow through. Or: make `{{notionContext}}` a no-op
after its first substitution per plan.
**Estimated saving:** 1.5K duplicate tokens per extra executor.

### #8 Compress executor outputs before synthesis when total > N tokens
**Problem:** `synthesize.ts` concatenates all step outputs verbatim.
A 4-executor plan with verbose middle steps can ship 8–10K input tokens
into the final sonnet call.
**Approach:** Either (a) truncate intermediate steps to their last
meaningful section, or (b) run a one-shot Haiku reduction of intermediate
outputs before synthesis. Skip entirely when `synthesisRequired=false`.
**Estimated saving:** 30–50% off synthesis input on plans that need it.

### #11 Tiered context budget (not flat 1500 tokens)
**Problem:** `buildNotionContext` uses `maxOutputTokens = 1500` for every
turn — same budget for "what's our brand voice?" as for "review Q3 OKRs".
**Approach:** Tier the budget — 500 for simple Q&A, 1500 for content tasks,
3000 for analysis. Tier picked by the planner or a router flag.
**Estimated saving:** 30–50% off compression output for cheap requests.

### #12 Cache compressed Notion context across turns in the same conversation
**Problem:** Follow-up messages in the same thread that touch the same
pages re-run the entire context pipeline (page selection + compression).
**Approach:** Persist `notionContext` keyed by `(pageIds, intentHash)` on
the `ExecutionPlan` (already exists) and reuse across `Conversation` for the
last N minutes. Invalidate on TTL or when `pageIds` changes.
**Estimated saving:** Eliminates compression on most follow-up turns.

---

## 📋 Phase 4 — Reviewer right-sizing & cleanup

### #13b Move reviewers from Sonnet → Haiku
**Problem:** `cmo-reviewer` and `cpo-reviewer` grade against fixed
criteria — a Haiku-class task. Sonnet here is overkill.
**Approach:** Update the seed `model` field for these reviewer agents.
**Caveat:** Verify quality first via the feedback-analyzer before flipping.
Don't ship blind.
**Estimated saving:** ~4× on reviewer call slots.

### #14 Either implement or remove the `managerThread` persistence
**Problem:** `plan.ts:286–288` saves only `[user message]` to
`ExecutionPlan.managerThread` — not the assistant plan response. The
design doc (`DESIGN-chat-agent.md:152–183`) says synthesis should replay
the full planning thread for continuity, but it doesn't.
**Approach:** Either:
  - **(a)** Save the full `[user, assistant(plan)]` thread (≈500 extra tokens
    in synthesis input, but synthesis sees the planner's reasoning), OR
  - **(b)** Drop the column and the loading code — simpler, smaller DB.
**Estimated impact:** Quality, not direct cost. Pick (a) if synthesis
output quality is mediocre; (b) otherwise.

---

## Measurement

Before shipping further phases, instrument:
- Per-call token counts (`generateText` returns `usage` — log to
  `ExecutionPlan.tokenCost` or a new `LLMCall` table).
- Cache hit ratio per call type (Anthropic returns
  `cache_creation_input_tokens` and `cache_read_input_tokens` in usage).
- Average plan length (steps per plan).
- % of turns that fire the Notion phase.

These metrics let you measure each phase's actual savings instead of
estimating, and they feed the feedback-analyzer for #13's quality
verification.

---

## Decision log

| Decision | Rationale |
|----------|-----------|
| Keep conversation history (rejected dropping it) | Continuity is the whole point of chat. Bound it (#10b) and cache it (#4) instead. |
| Cap pages at 5 in addition to char limit | Char limit alone allowed lots of small pages; the count cap is a cheap second guardrail. |
| Use `cachedSystem` helper rather than inlining `providerOptions` | One place to change cache TTL or strategy later. Non-Anthropic providers ignore the block. |
| Bound history at 12 messages / 4K tokens (not summarised) | Summarisation is a v2 problem; bounding alone covers the cost issue. Add rolling summaries when threads routinely run >50 messages. |
| Phase 2: tiny Haiku formatter pass instead of raw publish on `synthesisRequired=false` | Cheap insurance against executor preambles ("Here is the polished tweet:..."). ~$0.003 vs $0.04 for full Sonnet synthesis. |
| Phase 2: planner stays on Sonnet (Haiku flip reverted) | Plan output is JSON-shaped but the underlying task isn't simple: it requires picking the right executor from ~20 candidates, writing promptTemplates with the right constraints, holding the "shortest plan" line against habit patterns, and judging synthesisRequired. The downstream cost of one bad plan (one extra executor step ≈ +$0.02) wipes out the planner savings ($0.015). Revisit only with measurement, not intuition. |
| Phase 2: Notion context placed FIRST in a cached multi-block system (planner + executors) | The Notion context is the largest single shared blob across calls (~1.5K tokens). Putting it first with its own breakpoint means every executor in a plan that opts in via `{{notionContext}}` reuses the same cached prefix, regardless of the executor's own persona which comes after. This is a bigger win than the cross-turn case I initially optimised for. |
| Phase 2: when a step's promptTemplate uses `{{notionContext}}`, strip it from the prompt body and inject only via the cached system block | Otherwise the same content is paid twice — once in the cached system prefix, once inline in the user prompt. |
| Phase 2: dropped `cachedSystem` from short-prompt callsites | Below Anthropic's 1024/2048-token thresholds the cache_control block is silently ignored — keeping it added noise without value. Will reintroduce if any of those system prompts grow past the threshold. |
