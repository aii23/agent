# Feedback Analyzer — Design Document

## Understanding Summary

- **What:** A "bad result" reporting tool embedded in the chat interface. The user thumbs-down any assistant message, optionally types one line explaining what was wrong, and an analyzer runs immediately. It examines the full execution trace across all layers — router classification, manager planning, executor outputs, synthesis — diagnoses which layer(s) failed, and surfaces a modal with a diagnosis and one-click fixes that apply immediately to the agent config in the database.
- **Why:** The system produces non-deterministic outputs. There is no current mechanism to close the feedback loop — a bad result disappears into history with no path to improvement. This tool turns each bad result into an actionable agent improvement.
- **Who:** Internal team of 1–5. Same users operating the chat.
- **Key Constraints:**
  - Triggers from thumbs-down on assistant message in the chat thread
  - Optional free-text input ("What was wrong?")
  - Analysis surfaces as a modal over the chat thread
  - Fixes apply immediately and permanently to the `agents` table
  - Must reuse existing execution trace data (`execution_plans`, `workflow_steps`, `llm_calls`, `messages`)
  - tRPC for all API procedures (consistent with existing stack)
- **Non-Goals:** Versioning or rollback of applied fixes; background auto-detection of bad runs; a dedicated Feedback section in navigation; triggering from the Runs tab

## Assumptions

1. The analyzer is itself an LLM call — a meta-agent that receives the full trace as context and reasons about failure layers
2. The model for the analyzer is `claude-sonnet` — complex reasoning task, not router-level
3. Fixes are constrained to what the Agents UI already exposes: system prompt, model, `delegatesTo`, Notion scope
4. A new `MessageFeedback` table stores the thumbs-down signal, optional text, and the resulting analysis — for auditability
5. The analysis job runs via BullMQ (same as everything else); the modal polls at 2s intervals
6. `applyFix` is a tRPC mutation that applies the fix server-side and marks it applied in `MessageFeedback.analysis`
7. Max 3 fixes per analysis — conservative by design; small targeted changes only

---

## Data Model

Two additions to the existing schema. All existing tables unchanged.

```prisma
model MessageFeedback {
  id              String         @id @default(cuid())
  messageId       String         @unique        // assistant message that was thumbed down
  workflowRunId   String                        // run linked to that message
  userId          String
  feedbackText    String?                       // optional one-line from the user
  status          FeedbackStatus @default(pending)
  analysis        Json?                         // full AnalyzerOutput, stored on completion
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  message         Message        @relation(fields: [messageId], references: [id])
  workflowRun     WorkflowRun    @relation(fields: [workflowRunId], references: [id])
  user            User           @relation(fields: [userId], references: [id])
}

enum FeedbackStatus {
  pending      // job enqueued, not yet analyzed
  analyzing    // job running
  completed    // analysis ready
  failed       // analyzer errored
}
```

The `analysis` JSON column stores the full `AnalyzerOutput` — diagnosis, failure layer, and fix array. Storing it on the row keeps the audit trail intact even after fixes are applied (applied fixes are marked `applied: true` inside the JSON, not deleted).

The `messageId` uniqueness constraint prevents double-submission — thumbs-down twice on the same message is a no-op.

---

## Analyzer Meta-Agent

### Input

Assembled server-side on the tRPC `submit` mutation before the job is enqueued. The worker receives a fully assembled payload — no DB reads inside the job.

```typescript
type AnalyzerInput = {
  userMessage:          string                    // original user request
  feedbackText:         string | null             // optional user explanation
  routerDecision:       { domain: string; mode: string }
  managerAgent: {
    slug:               string
    systemPrompt:       string
    delegatesTo:        string[]
    model:              string
  }
  executionPlan:        { steps: PlanStep[] }
  managerPlanningThread: LLMMessage[]             // from execution_plans.messages
  executorResults: {
    agent:              string
    input:              unknown
    output:             unknown
    status:             "completed" | "failed"
    durationMs:         number
  }[]
  finalSynthesis:       string                    // the assistant message that was thumbed down
}
```

### Output (Zod-validated)

```typescript
type AnalyzerOutput = {
  failedLayer: "router" | "planning" | "executor" | "synthesis" | "multiple"
  summary:     string          // 2–3 sentence plain-English diagnosis
  fixes:       Fix[]           // max 3
}

type Fix =
  | { type: "update_prompt";      agentSlug: string; currentValue: string;    suggestedValue: string;    reasoning: string; applied?: boolean }
  | { type: "update_delegatesTo"; agentSlug: string; currentValue: string[];  suggestedValue: string[];  reasoning: string; applied?: boolean }
  | { type: "update_model";       agentSlug: string; currentValue: string;    suggestedValue: string;    reasoning: string; applied?: boolean }
  | { type: "update_notionScope"; agentSlug: string; currentValue: unknown;   suggestedValue: unknown;   reasoning: string; applied?: boolean }
```

### Analyzer System Prompt (summary)

- You are a diagnostic agent. You receive a full execution trace for an AI agent run that the user marked as bad.
- Your job: identify which layer failed (router, planning, executor, synthesis, or multiple) and propose specific, minimal fixes.
- Be conservative. Only suggest a fix when confident. Never suggest more than 3 fixes. Prefer small targeted prompt additions over full rewrites.
- Every fix must reference a real agent slug from the trace. Never invent agent slugs.
- If you cannot identify a specific fix, return an empty fixes array — the summary alone has value.

---

## Execution Flow

```
User clicks 👎 on assistant message
  → Optional text input appears inline ("What was wrong?")
  → User submits (or skips)
  → tRPC feedback.submit mutation
      → Creates MessageFeedback { status: pending }
      → Assembles AnalyzerInput from DB in one pass
          (messages + execution_plans + workflow_steps + agents)
      → Enqueues BullMQ job: feedback-analyzer { feedbackId, analyzerInput }
      → Returns { feedbackId }
  → Modal opens immediately showing "Analyzing..." skeleton

BullMQ worker: feedback-analyzer
  → Updates MessageFeedback { status: analyzing }
  → Calls claude-sonnet with system prompt + AnalyzerInput as context
  → Validates response against AnalyzerOutput Zod schema
  → On success: stores result in MessageFeedback.analysis { status: completed }
  → On Zod failure: retries once; on second failure { status: failed }

Modal polls tRPC feedback.get every 2s
  → On completed → renders diagnosis + fix cards
  → On failed    → renders error state: summary text if available, otherwise generic message
```

**Degraded state on analyzer failure:** If Zod validation fails on both attempts, the modal shows: *"We identified a problem but couldn't generate specific fixes."* The `summary` text is always shown if present — the diagnosis alone has value even without actionable fixes.

---

## tRPC Router

```typescript
// server/routers/feedback.ts

feedback: router({

  submit: protectedProcedure
    .input(z.object({
      messageId:     z.string(),
      workflowRunId: z.string(),
      feedbackText:  z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Creates MessageFeedback { status: pending }
      // 2. Assembles AnalyzerInput from DB
      // 3. Enqueues BullMQ feedback-analyzer job
      // Returns { feedbackId }
    }),

  get: protectedProcedure
    .input(z.object({ feedbackId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Returns { status, analysis }
      // Polled at 2s intervals by the modal
    }),

  applyFix: protectedProcedure
    .input(z.object({
      feedbackId: z.string(),
      fixIndex:   z.number(),    // index into analysis.fixes[]
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Reads the fix at fixIndex from MessageFeedback.analysis
      // 2. Applies change to agents table via existing agent update logic
      // 3. Marks fix as applied: true in MessageFeedback.analysis
    }),

})
```

`applyFix` applies the fix server-side — the modal does not call the agent update endpoint directly. This keeps fix application logic co-located with the feedback data and allows atomic marking of applied state.

---

## Modal UI

```
┌─────────────────────────────────────────────────────┐
│  Analysis: "Generate a post about our product launch"│
│                                              [✕ Close]│
├─────────────────────────────────────────────────────┤
│  🔴  Failed layer: Planning                          │
│                                                      │
│  The CMO chose content-generator → cpo-reviewer,    │
│  but your message asked for a calendar plan, not a  │
│  single post draft. The manager misread the intent   │
│  and selected the wrong executors for the task.      │
├─────────────────────────────────────────────────────┤
│  Suggested Fixes                                     │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │ CMO · System Prompt                           │  │
│  │ ─────────────────────────────────────────── │  │
│  │ BEFORE  "Generate content based on request"  │  │
│  │ AFTER   "Distinguish between single-asset    │  │
│  │          requests (posts, copy) and planning  │  │
│  │          requests (calendars, strategies).    │  │
│  │          For planning requests use            │  │
│  │          content-planner as first step."      │  │
│  │                                               │  │
│  │ Why: Manager conflated post generation with  │  │
│  │ calendar planning — needs explicit guidance.  │  │
│  │                                    [Apply ✓] │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │ CMO · delegatesTo                             │  │
│  │ ─────────────────────────────────────────── │  │
│  │ BEFORE  [..., "content-validator"]            │  │
│  │ AFTER   [..., "content-validator",            │  │
│  │               "content-planner"]              │  │
│  │                                               │  │
│  │ Why: content-planner is not in delegatesTo    │  │
│  │ so it was unavailable to the manager.         │  │
│  │                                    [Apply ✓] │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│                          [Apply All]  [Dismiss]      │
│                                                      │
│  (after all applied) → Re-run this message? →        │
└─────────────────────────────────────────────────────┘
```

- Failed layer badge: 🔴 for clear failure, 🟡 for quality issue where nothing technically errored
- Each fix card: agent + field, before/after diff, reasoning, individual Apply button
- Applied fixes: button becomes a grey checkmark — cannot be un-applied
- "Apply All": applies all pending fixes in sequence
- "Re-run this message?": re-submits the original user message in the same conversation after all fixes applied — closes the improvement loop

---

## New Files

```
server/routers/feedback.ts           # tRPC router (3 procedures)
workers/feedback-analyzer.ts         # BullMQ job handler
agents/feedback-analyzer.ts          # meta-agent definition (system prompt, Zod schemas)
components/chat/feedback-modal.tsx   # modal component
components/chat/feedback-button.tsx  # thumbs-down + text input on assistant messages
```

No changes to the existing worker, orchestrator, chat agents, or any other existing file.

---

## Edge Cases

| Case | Handling |
|---|---|
| User thumbs-down the same message twice | `messageId` uniqueness constraint — second submission returns existing `feedbackId` |
| Analyzer references a non-existent agent slug | Zod validation fails. Retry once. If second attempt also invalid, `status: failed`, modal shows summary only |
| Trace data missing (e.g. inline-mode message with no execution_plan) | `AnalyzerInput` is assembled with nulls for missing fields. System prompt instructs the analyzer to work with partial data and not hallucinate missing steps |
| User applies a fix then immediately re-runs — result is still bad | They can thumbs-down again. A new `MessageFeedback` row is created (different `messageId`). The new analysis has the updated agent config as context |
| `applyFix` fails (DB error) | tRPC mutation returns error. Fix is not marked applied. User sees an error toast — can retry |
| All 3 fixes applied, "Re-run" clicked | Re-submits original `userMessage` as a new user message in the same conversation. Standard execution flow from there |

---

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | Single meta-agent analyzer (one LLM call) | Multi-pass layered analysis; heuristics + LLM | Trace is compact (2–5K tokens). One job, one result, one Zod schema. Handles subtle quality failures that heuristics miss. |
| 2 | `claude-sonnet` for the analyzer | `gemini-flash`; `claude-opus` | Complex reasoning across multiple failure modes, but not worth opus cost. Sonnet is the right tier. |
| 3 | Triggered by thumbs-down on chat message | Runs tab trigger; automatic detection | Lowest friction — feedback is given where the bad result appeared. |
| 4 | Optional free-text input, no tags | Tags only; required text; no input at all | Tags add friction without much value for a team of 1–5. Free text is optional so it never blocks submission. |
| 5 | Modal over chat thread | Inline card; navigate to Runs tab | Stays in context. Dismisses cleanly. Does not interrupt the conversation flow. |
| 6 | Fixes apply immediately and permanently | Versioned/rollback; pending suggestions; opens Agents UI pre-filled | For a team of 1–5, the overhead of a review step outweighs the risk. The audit trail in `MessageFeedback.analysis` preserves what was changed and why. |
| 7 | `applyFix` tRPC procedure (server-side fix application) | Client calls agent update endpoint directly | Keeps fix logic server-side. Modal does not need to know agent update internals. Fix is marked applied atomically. |
| 8 | Polling at 2s for analysis result | SSE for analysis job | Analysis is a single one-shot result, not a stream. Polling is simpler and sufficient. |
| 9 | Input assembled on tRPC mutation before enqueue | Assembled inside the worker | DB joins happen once, at submission time. Worker receives a complete payload — no DB reads inside the job. |
| 10 | Max 3 fixes per analysis | Unlimited | Conservative by design. Sweeping rewrites from one bad result are risky. Small targeted changes are safer and more actionable. |
| 11 | "Re-run this message?" link after all fixes applied | Separate button; no shortcut | Closes the improvement loop immediately. Low effort to add, high value for verifying the fix worked. |
