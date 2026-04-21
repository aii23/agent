# Chat Agent — Token Cost Improvements

Tracking document for ongoing cost-reduction work on the chat agent flow
(`orchestrator/{plan,execute,synthesize,context}.ts`).

Phase 1 has shipped. Phases 2–4 are queued as a prioritised backlog.

---

## ✅ Phase 1 — Shipped

Quick wins. Estimated 60–70% cost reduction on the average chat turn.

| # | Change | File | Notes |
|---|--------|------|-------|
| 1 | Scope Notion catalog to `agent.notionScope` (was: full workspace on every turn) | `orchestrator/plan.ts` | Honors design doc; was a bug |
| 2 | Lower `MAX_TOTAL_INPUT_CHARS` 150K → 30K, cap to 5 pages, per-page 20K → 12K | `orchestrator/context.ts` | Compression input ~5× smaller |
| 3 | Anthropic prompt caching on every system prompt (planner, page-selector, context compressor, executors, synthesis) | `lib/llm-cache.ts` (new) + all orchestrator files | ~10% input cost on cache hits |
| 4 | Drop the dual-reviewer default; pick `content-validator` OR `cmo-reviewer`, not both | `prisma/agents/managers/index.ts` (CMO) | Re-run `pnpm db:seed` to apply |
| 5 | Bound conversation history: last 12 messages / 4K tokens, DONE-only, with cache breakpoint on the last message | `lib/conversation-history.ts` (new), `orchestrator/plan.ts` | Stops linear cost growth on long threads |

**To activate Phase 1 fully:** run `pnpm db:seed` so the updated CMO prompt
reaches the database. The other changes are picked up on the next worker restart.

---

## 📋 Phase 2 — Planner discipline

Target: cut another 30–40% by stopping the planner from over-orchestrating
small requests.

### #3 Skip the Notion phase when not needed
**Problem:** Every chat turn fires two Haiku calls (page selection +
compression) even when the user's message is self-contained ("polish this
tweet I'm pasting", "what's 2+2?").
**Approach:** Add a precheck — either a tiny classifier ("does this request
need workspace context?") or a router-level `needsContext: boolean` flag.
When false, skip both Haiku calls.
**Estimated saving:** ~$0.035 + ~3s latency on a large fraction of turns.

### #5 Rewrite "standard plan shapes" + add few-shot examples
**Problem:** The manager prompts list plan recipes the LLM treats as
templates. It picks the listed shape even when the request is smaller.
**Approach:** Replace recipe-style guidance with a single rule ("the shortest
plan that does the job") plus 2 few-shot examples — one minimal plan
(1 step) and one full pipeline (4 steps) — so the model sees the *range*,
not just the maximum.
**Estimated saving:** 40–60% fewer executor calls on average.

### #7 Stop duplicating `{{notionContext}}` across executor steps
**Problem:** The full Notion context block is injected into the planner's
system prompt AND re-injected into every step that uses `{{notionContext}}`.
For multi-step plans, the same 1.5K token blob is paid 2–4×.
**Approach:** Inject `{{notionContext}}` only into the *first* executor step
that requests it. Downstream steps reference `{{steps[0].output}}` if they
need the brand context to flow through. Or: make `{{notionContext}}` a no-op
after its first substitution per plan.
**Estimated saving:** 1.5K duplicate tokens per extra executor.

---

## 📋 Phase 3 — Synthesis efficiency

Target: cut synthesis cost by 50–70%, sometimes eliminate it entirely.

### #9 `synthesisRequired: false` path
**Problem:** When the last executor's output already *is* the deliverable
(polished tweets, drafted email), synthesis just reformats it. That's a
~$0.04 sonnet call producing zero new value.
**Approach:** Add `synthesisRequired: boolean` to `ExecutionPlanSchema`.
When the manager sets it to `false`, the orchestrator publishes the last
step's output directly as the assistant message and skips synthesis.
**Estimated saving:** Eliminates one sonnet call (~$0.04) on ~40% of turns.

### #8 Compress executor outputs before synthesis when total > N tokens
**Problem:** `synthesize.ts:39` concatenates all step outputs verbatim.
A 4-executor plan with verbose middle steps can ship 8–10K input tokens
into the final sonnet call.
**Approach:** Either (a) truncate intermediate steps to their last
meaningful section, or (b) run a one-shot Haiku reduction of intermediate
outputs before synthesis. Skip entirely when the last step is the
deliverable (covered by #9).
**Estimated saving:** 30–50% off synthesis input.

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

## 📋 Phase 4 — Model right-sizing

Target: 10× cheaper on individual call slots that don't need Sonnet.

### #13 Move planner + reviewers from Sonnet → Haiku
**Problem:** Plan generation is structured-output classification — Haiku
handles it well. Reviewers grade against fixed criteria — also a Haiku
task. Sonnet here is overkill.
**Approach:** Switch `manager.model` for the planning call to Haiku (keep
Sonnet for synthesis). Switch `cmo-reviewer` and `cpo-reviewer` to Haiku.
**Caveat:** Verify quality first via the feedback-analyzer before flipping.
Don't ship blind.
**Estimated saving:** ~10× on those call slots.

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
