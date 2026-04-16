# Chat Agent System — Design Document

## Understanding Summary

- **What:** A persistent, ChatGPT-style chat interface added to the Praxis platform, backed by six C-suite manager agents (CEO, CPO, CMO, CTO, CFO, CLO) that receive user intent, query Notion context, dynamically plan which executor agents to invoke, and synthesise results — 2-level dynamic planning where managers plan and executors do the work
- **Why:** Natural language is a faster and more intuitive interface than form-based workflow launchers. Consolidates project knowledge (Notion) with task execution (workflows) in one conversational surface.
- **Who:** Internal team of 1–5, same audience as the broader Praxis platform
- **Key Constraints:**
  - TypeScript stack, existing infrastructure (BullMQ, Postgres, Redis, Notion SDK, Vercel AI SDK) — maximum reuse
  - All chat execution runs through BullMQ — no second execution path
  - SSE + Redis pub/sub provides streaming feel over async execution
  - Chat and Runs tab are parallel surfaces sharing the same underlying API
  - Self-hosted deployment
- **Non-Goals:** Replacing the Runs/Workflows UI, real-time multi-user collaboration in one thread, mobile app, external access, conversation history as agent context (v1)

## Assumptions

1. Each C-suite agent has a defined Notion scope (databases/pages it can access) — stored as JSON in the agent definition, editable via the Agents UI
2. The implicit router uses `gemini-flash` (cheapest model, reliable structured output) to classify intent — ~200ms overhead per message
3. Conversation history is stored in Postgres and displayed in the UI, but not injected into agent context in v1 — memory is a v2 feature
4. Each C-suite agent knows its available executors via `delegatesTo` and generates an execution plan at runtime. The CMO's executor pool includes `content-generator`, `content-polisher`, `content-planner`, `content-validator`, `cpo-reviewer`; other C-suite agents grow their executor pools as the system evolves
5. Explicit agent selection is available via a `@mention` syntax in the message input or a dropdown at the top of the thread
6. Human gate approvals can be actioned inline in the chat thread — they call the same gate API the Runs tab uses
7. Conversation titles are auto-generated from the first user message and are editable in the sidebar
8. The worker publishes token chunks and step events to Redis pub/sub — one channel per workflow run (`chat:run:{runId}`)

## Architecture

### Execution Flow

```
User sends message
  → POST /api/chat/[conversationId]/messages
      → Creates Message record (role: "user")
      → Router agent classifies: { domain, mode }
      → Creates WorkflowRun (linked to message)
      → Enqueues BullMQ job for the C-suite manager agent
      → Returns { messageId, runId }

Client opens SSE connection
  → GET /api/chat/[conversationId]/stream?runId=xxx
      → Server subscribes to Redis pub/sub: chat:run:{runId}
      → Keeps connection open, forwards events as they arrive

BullMQ worker executes (manager phase)
  → C-suite agent fetches Notion context (scoped tools)
  → Calls LLM → generates execution plan (which executors, what order, what inputs)
  → Plan validated against delegatesTo allowlist and max-steps limit
  → Plan + LLM message thread persisted to execution_plans table
  → Publishes plan_generated event to Redis

BullMQ worker executes (executor phase)
  → Orchestrator enqueues executor steps sequentially
  → Each executor runs, stores result, triggers next step
  → Publishes token chunks, step events, approval gates to Redis
  → human_gate steps pause for user approval

BullMQ worker executes (synthesis phase)
  → Loads manager's saved message thread from execution_plans
  → Appends executor results as new message
  → Calls LLM → synthesises final response (same conversation as planning)
  → Persists final message to Postgres
  → Publishes done event

Client renders
  → plan_generated → collapsible plan summary card
  → Token chunks → streaming assistant message bubble
  → workflow_step events → inline step progress cards
  → approval_needed → interactive approve/reject card
```

### SSE Event Types

| Event | Payload | UI Effect |
|---|---|---|
| `plan_generated` | `{ steps: [{ agent, description }] }` | Renders collapsible plan summary card |
| `token` | `{ content: string }` | Appends to current assistant message bubble |
| `done` | `{ messageId: string }` | Finalises message, saves to DB |
| `workflow_step` | `{ stepName, status, output? }` | Renders inline step progress card |
| `approval_needed` | `{ stepOutput, workflowRunId }` | Renders approve/reject/edit buttons in thread |
| `error` | `{ message: string }` | Renders error state in thread |

## Router

A lightweight classification agent that runs before every message. Uses `gemini-flash` (cheapest model with reliable structured output). Makes two decisions:

```typescript
{
  domain: "ceo" | "cpo" | "cmo" | "cfo" | "cto" | "clo" | null,
  mode: "inline" | "delegate"
}
```

- **domain** — which C-suite agent owns this request. `null` = general, falls back to a broad Notion search agent
- **mode** — `inline` for read/answer tasks (manager answers directly); `delegate` for tasks requiring executor agents (manager generates a plan)

The router no longer picks a specific workflow template — that responsibility moves to the C-suite manager agent, which dynamically plans which executors to use based on the request.

If the user has explicitly selected an agent (via `@mention` or dropdown), the router skips domain classification and determines mode only.

## C-Suite Agents

Each agent is a standard `Agent` database record (same model as existing agents) with three additional fields:

| Field | Purpose |
|---|---|
| `role: "manager"` | Signals this is a top-level planning agent |
| `notionScope` | JSON: which Notion databases/pages this agent can access |
| `delegatesTo` | Array of executor agent slugs this manager can include in plans |

### Notion Scope per Agent

| Agent | Notion Access |
|---|---|
| CEO | Strategy pages, roadmap, OKRs, meeting notes |
| CPO | Product specs, task databases, sprint/deadline pages |
| CMO | Content calendar database, brand/voice pages, campaign docs |
| CFO | Finance pages, budget docs, expense tracking |
| CTO | Technical docs, architecture pages, eng task database |
| CLO | Legal docs, contracts, compliance pages |

Scopes are JSON — editable from the Agents UI without redeployment.

### Agent Behaviour by Mode

**Inline mode:**
1. Receives user message
2. Fetches relevant Notion context via scoped tools
3. Answers directly — response streamed back via Redis pub/sub → SSE
4. No planning step, no executor agents involved

**Delegate mode:**
1. Receives user message + Notion context
2. Calls LLM with the user request, available executors (`delegatesTo`), and Notion context
3. LLM returns a structured execution plan:
   ```typescript
   {
     steps: [
       { agent: "content-generator", input: { idea: "product launch" }, description: "Generate initial draft" },
       { agent: "cpo-reviewer", input: { draft: "{{content-generator.output}}" }, description: "Review for quality" }
     ],
     requiresHumanGate: true  // manager decides if final output needs approval
   }
   ```
4. Plan is validated: all agent slugs must exist in `delegatesTo`, step count ≤ 8, input references are valid
5. Plan + full LLM message thread persisted to `execution_plans` table, `plan_generated` event published
6. Orchestrator executes steps sequentially via BullMQ — each step's output feeds into the next step's `{{ref}}` placeholders
7. After all steps complete, manager's saved message thread is loaded and executor results are appended as a new message — the synthesis LLM call sees one continuous conversation (plan reasoning + results)
8. Manager synthesises a final response with full context of why it planned what it planned
9. If `requiresHumanGate: true`, an approval card is surfaced before the response is finalised

### Manager Context Threading

The plan and synthesis jobs are two halves of one manager conversation, split by executor work. To keep the manager's reasoning chain intact, the full LLM message thread is persisted on the `execution_plans` row between calls:

```
PLAN JOB saves to execution_plans.messages:
  ┌──────────────────────────────────────────────────────────┐
  │ { role: "system",    content: "You are the CMO..." }     │
  │ { role: "user",      content: "Generate a post about..." │
  │                               + Notion context }         │
  │ { role: "assistant", content: "I'll generate a draft     │
  │                               using content-generator,   │
  │                               then have cpo-reviewer..." │
  │                               + structured plan }        │
  └──────────────────────────────────────────────────────────┘

         ... executor agents run, results stored ...

SYNTHESIS JOB loads execution_plans.messages, appends:
  ┌──────────────────────────────────────────────────────────┐
  │ { role: "user",      content: "Executor results:         │
  │                               step 0 (content-generator):│
  │                                 <draft text>             │
  │                               step 1 (cpo-reviewer):     │
  │                                 <review feedback>" }     │
  └──────────────────────────────────────────────────────────┘

  → LLM sees one continuous conversation: intent → plan → results
  → Synthesises with full context of what was asked and why
```

The token cost of replaying the planning context is small (~500–1000 tokens) relative to the quality improvement. Without it, the synthesis call has no memory of why it chose specific executors or what the user actually wanted — it just gets raw outputs from agents it doesn't remember dispatching.

### CMO Agent — Example Delegation

The CMO dynamically plans based on the request. Different requests produce different plans:

**Example 1: "Generate a post about our product launch"**
```
  → Router: { domain: "cmo", mode: "delegate" }
  → CMO fetches brand voice page + content calendar from Notion
  → CMO LLM generates plan:
      steps: [
        { agent: "content-generator", input: { idea: "product launch", voice: "..." } },
        { agent: "cpo-reviewer", input: { draft: "{{content-generator.output}}" } }
      ]
      requiresHumanGate: true
  → Executors run sequentially, step events stream to chat
  → CMO synthesises: "Here's the draft based on your brand voice..."
  → Human gate surfaces as approval card
```

**Example 2: "Plan next month's content calendar"**
```
  → Router: { domain: "cmo", mode: "delegate" }
  → CMO fetches current calendar + campaign docs from Notion
  → CMO LLM generates plan:
      steps: [
        { agent: "content-planner", input: { timeframe: "next month", existing: "..." } },
        { agent: "content-validator", input: { plan: "{{content-planner.output}}" } }
      ]
      requiresHumanGate: true
  → Different plan, same manager — no template needed
```

**Example 3: "What did we post last week?"**
```
  → Router: { domain: "cmo", mode: "inline" }
  → CMO queries content calendar in Notion directly
  → Responds with summary — no executors, no plan
```

## Data Model

Three new tables added to the existing Postgres schema. All existing tables unchanged.

```prisma
model Conversation {
  id          String    @id @default(cuid())
  userId      String
  title       String?   // auto-generated from first message, editable
  agentSlug   String?   // null = implicit routing; set = user-pinned agent
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  user        User      @relation(fields: [userId], references: [id])
  messages    Message[]
}

model Message {
  id              String        @id @default(cuid())
  conversationId  String
  role            MessageRole   // "user" | "assistant" | "system"
  content         String        // text or JSON for rich messages
  agentSlug       String?       // which C-suite agent responded
  workflowRunId   String?       // links to existing WorkflowRun if triggered
  createdAt       DateTime      @default(now())

  conversation    Conversation  @relation(fields: [conversationId], references: [id])
  workflowRun     WorkflowRun?  @relation(fields: [workflowRunId], references: [id])
}

model ExecutionPlan {
  id              String    @id @default(cuid())
  workflowRunId   String    @unique
  managerAgent    String    // slug of the C-suite agent that generated this plan
  steps           Json      // [{ agent, input, description }]
  messages        Json      // manager's LLM message thread — persisted after planning, loaded for synthesis
  requiresGate    Boolean   @default(false)
  status          PlanStatus @default(executing)
  tokenCost       Int       @default(0)  // cumulative tokens across plan + execute + synthesise
  createdAt       DateTime  @default(now())

  workflowRun     WorkflowRun @relation(fields: [workflowRunId], references: [id])
}

enum PlanStatus {
  executing
  completed
  failed
  cost_exceeded
}

enum MessageRole {
  user
  assistant
  system
}
```

## UI Structure

### Navigation

| View | Purpose |
|---|---|
| **Chat** ← new | Conversational interface to all C-suite agents |
| Workflows | Browse and launch workflow templates |
| Runs | Monitor active/completed runs, approve human gates |
| Agents | View/edit agent registry (roles, prompts, tools, Notion scope) |
| Settings | Notion OAuth, LLM provider keys, wallet allowlist |

### Chat Layout

```
┌──────────────────┬────────────────────────────────────────┐
│  Conversations   │                                        │
│  ─────────────   │   @CMO  ▾                              │
│  + New Chat      │  ─────────────────────────────────── │
│                  │                                        │
│  Today           │  [User] Generate a post about our     │
│  › Content plan  │         product launch                 │
│  › Q3 strategy   │                                        │
│                  │  [CMO]  On it. Starting generate-post  │
│  Yesterday       │  ┌─────────────────────────────────┐  │
│  › CTO sync      │  │ ✓ content-generator  done        │  │
│  › Legal review  │  │ ⟳ cpo-reviewer       reviewing…  │  │
│                  │  └─────────────────────────────────┘  │
│                  │                                        │
│                  │  [CMO]  Draft ready for review:        │
│                  │  ┌─────────────────────────────────┐  │
│                  │  │ "Our product launch changes..."  │  │
│                  │  │                                  │  │
│                  │  │ [✓ Approve] [✗ Reject] [Edit]   │  │
│                  │  └─────────────────────────────────┘  │
│                  │                                        │
│                  │  ┌──────────────────────────────────┐ │
│                  │  │ Message...                    [↑] │ │
│                  │  └──────────────────────────────────┘ │
└──────────────────┴────────────────────────────────────────┘
```

### UI Behaviour Details

**Agent selector** (`@CMO ▾` dropdown at thread top):
- Default: `Auto` — router picks the domain agent
- Options: CEO / CPO / CMO / CTO / CFO / CLO
- Stored on `Conversation.agentSlug`, persists for the thread
- Per-message override via `@AgentName` mention in the input

**Conversation sidebar:**
- Titles auto-generated from first user message (~40 chars), double-click to edit
- Grouped by Today / Yesterday / Older
- Cursor-based pagination for long history lists

**Message rendering:**
- User messages: clearly distinguished (right-aligned or accent colour)
- Assistant messages: token-streaming as they arrive, persisted on `done` event
- `workflow_step` events: compact collapsible progress card inline in thread
- `approval_needed`: full interactive card — Approve / Reject / Edit buttons calling the same `/api/workflows/[runId]/gate` endpoint as the Runs tab

## Project Structure

```
src/
├── app/
│   └── (dashboard)/
│       ├── chat/
│       │   ├── page.tsx                    # Redirects to last conversation
│       │   └── [conversationId]/
│       │       └── page.tsx                # Chat thread view
│       └── api/
│           └── chat/
│               ├── [conversationId]/
│               │   ├── messages/
│               │   │   └── route.ts        # POST: create message, enqueue job
│               │   └── stream/
│               │       └── route.ts        # GET: SSE endpoint, Redis relay
│               └── conversations/
│                   └── route.ts            # GET: list, POST: create
├── agents/
│   ├── registry.ts                         # Extended with C-suite agents
│   ├── router.ts                           # Intent classification agent
│   ├── ceo.ts
│   ├── cpo.ts
│   ├── cmo.ts                              # Wraps existing content agents
│   ├── cfo.ts
│   ├── cto.ts
│   └── clo.ts
```

Changes to existing code:
- `workers/agent-worker.ts` — extended to handle the 3-phase execution loop (plan → execute → synthesise)
- `orchestrator/planner.ts` — new: plan validation, ref resolution, guardrail enforcement
- Redis pub/sub publish calls added to the worker's step execution loop
- No changes to `integrations/notion/`, `auth/`, or `lib/`

## Edge Cases

| Case | Handling |
|---|---|
| Router can't classify domain | Falls back to a general agent with full Notion search scope. Response indicates which agent answered. |
| User sends message before SSE connects | Client polls `workflow_steps` for the runId on mount as a catch-up mechanism |
| SSE connection drops mid-stream | Client reconnects and replays undelivered events from `workflow_steps` using `?after=lastEventTimestamp` |
| C-suite agent has no relevant Notion data | Agent responds honestly: "I couldn't find relevant information." No hallucination. |
| Workflow triggered from chat and approved in Runs tab | Both call the same gate API — first approval resolves the gate, second call returns current state (idempotent) |
| User `@mentions` agent mid-conversation | Overrides domain for that message only. `Conversation.agentSlug` unchanged. |
| Long conversation history (100+ messages) | Virtualised scroll in UI. Cursor-based pagination on Postgres query. |
| Manager generates invalid plan (unknown executor) | Plan validation rejects it. Manager is re-prompted once with the error. If second attempt fails, returns error to user. |
| Manager generates plan exceeding max steps | Plan rejected. Manager re-prompted with stricter constraint: "Use at most {limit} steps." |
| Executor step fails mid-plan | Orchestrator marks step as failed, skips remaining steps, returns partial results to manager. Manager synthesises response explaining what succeeded and what failed. |
| Run exceeds cost ceiling | Orchestrator aborts remaining steps. Manager receives partial results and a cost-exceeded flag. User sees an error card with the partial output. |
| Same request produces different plans on retry | Expected behaviour — plans are non-deterministic. The execution_plans table preserves the exact plan used for each run for auditability. |

## Error Handling

- **SSE publish failure:** Worker catches Redis errors and falls back to storing output in `workflow_steps.output` (Postgres). Client detects stalled stream and falls back to polling.
- **Router LLM failure:** Falls back to the general agent. Error logged but not surfaced to user.
- **Plan generation LLM failure:** Manager agent retries once. If second attempt fails, falls back to inline mode (answers directly without executors). SSE emits `error` event if inline fallback also fails.
- **Plan validation failure:** Manager re-prompted with the validation error as context (e.g. "agent 'unknown-agent' is not in your executor pool"). Max 1 retry, then error to user.
- **Executor step failure:** Step marked failed in `workflow_steps`. Orchestrator does not retry individual steps (BullMQ retries the step job). After max retries, orchestrator skips to synthesis with partial results.
- **Cost ceiling exceeded:** Remaining steps cancelled. Manager synthesises from partial results with a flag indicating truncation. User sees cost warning in the plan progress card.
- **C-suite agent LLM failure (inline mode):** BullMQ retries the job (existing retry behaviour). SSE emits `error` event after max retries exceeded.
- **Notion scope access failure:** Agent returns a structured error message. User is prompted to check Notion connection in Settings.

## Testing Strategy

| Layer | What to test | How |
|---|---|---|
| Router | Correct domain + mode classification for known inputs | Mock LLM, fixed responses, verify Zod output |
| C-suite agents (inline) | Correct Notion tool calls, structured answer output | Mock Notion tools, mock LLM |
| Plan generation | Valid plan structure, only uses allowed executors, respects max steps | Mock LLM to return known plans, verify Zod validation passes |
| Plan validation | Rejects unknown executors, over-limit plans, invalid refs | Unit test with crafted invalid plans |
| Plan execution | Steps run in order, output refs resolve correctly, partial failure handled | Integration test: real BullMQ + Redis, mock executor LLMs |
| Cost ceiling | Run aborts when cumulative cost exceeds limit, partial results returned | Integration test with artificially low ceiling |
| Synthesis | Manager produces coherent response from executor outputs | Mock executor results, verify final output structure |
| SSE streaming | Token chunks + plan_generated + step events arrive in order | Integration test: real BullMQ + Redis in test env |
| Approval card | Approve/reject calls gate API, gate resolves correctly | Integration test against existing gate endpoint |
| Conversation history | Messages persisted and retrieved in correct order | Postgres integration test |
| Router fallback | Unknown intent routes to general agent gracefully | Mock router LLM to return null domain |
| Plan re-prompting | Invalid first plan triggers re-prompt, second attempt succeeds | Mock LLM: first call returns invalid plan, second returns valid |

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | BullMQ for all chat execution | Dual-mode (inline + BullMQ); pure tool-call loop | Maximum reuse of existing infrastructure. Durability, retry, and observability come for free. SSE provides streaming feel without a second execution path. |
| 2 | SSE + Redis pub/sub for streaming | Polling (5s); WebSocket | Polling too slow for chat feel. SSE is simpler than WebSocket for unidirectional server→client events. Redis is already in the stack. |
| 3 | C-suite agents as domain manager agents | Single smart agent; intent-based agents | C-suite framing gives each agent a coherent identity, data scope, and authority model. Easier to tune prompts per domain. Natural mental model for the team. |
| 4 | Implicit router with explicit override | Always explicit; always implicit | Implicit is the default UX — just type. Explicit override via `@mention` or dropdown covers edge cases without adding friction. |
| 5 | Notion scope per agent stored as JSON in agent definition | Hardcoded per agent; separate config table | Editable from the existing Agents UI without redeployment. Consistent with existing agent config model. |
| 6 | Approval in chat calls same gate API as Runs tab | Separate approval mechanism for chat | Single API keeps both surfaces in sync automatically. No duplicated logic. |
| 7 | History is UI-only in v1 (no context injection) | Full memory from day one | Simplest correct starting point. Avoids token bloat and context management complexity. Real memory is a clear v2 upgrade. |
| 8 | Auto-generated conversation titles | User-named only; AI-summarised titles | Auto from first message is instant and good enough. Editable in sidebar for when it matters. |
| 9 | Agent prompts editable in existing Agents UI | Separate chat agent config screen | Reuses existing infrastructure. All agent configuration in one place. |
| 10 | Dynamic planning over static workflow templates | Static `workflowId` lookup; unbounded recursive planning | Static templates require manual definition for every new pattern. Unbounded recursion causes cost explosion and debugging nightmares. 2-level dynamic planning (manager plans, executors execute) gives flexibility while staying debuggable. Manager decides at runtime which executors to use — no new template needed for new request patterns. |
| 11 | Router classifies domain + mode only (no workflowId) | Router picks specific workflow template | Planning responsibility moves to the C-suite agent, which has Notion context and domain expertise. Router stays cheap and fast — it just picks the right manager. |
| 12 | Max 8 steps + cost ceiling per plan | No limits; per-step limits only | Hard cap prevents runaway plans from an overenthusiastic LLM. Cost ceiling catches expensive step accumulation. Both configurable per manager in the Agents UI. |
| 13 | Manager synthesises final response after executors complete | Return raw executor output; let UI combine outputs | Manager has domain context to interpret, summarise, and present executor results coherently. Raw output would be fragmented and hard to read in chat. |
| 14 | Persist manager LLM thread on execution_plans, replay for synthesis | Stateless synthesis (no planning context); store context blob separately | Replaying the full message thread gives the synthesis call the manager's own reasoning chain — it knows what it planned and why. Token cost is ~500–1000 extra tokens, negligible vs quality gain. Storing on the plan row keeps it co-located and avoids an extra table. |
