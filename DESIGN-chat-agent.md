# Chat Agent System — Design Document

## Understanding Summary

- **What:** A persistent, ChatGPT-style chat interface added to the Praxis platform, backed by six C-suite domain agents (CEO, CPO, CMO, CTO, CFO, CLO) that act as managerial agents — receiving user intent, querying Notion context, and delegating to lower-level executor agents via the existing workflow system
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
2. The implicit router uses the `fast` LLM tier (cheapest model, structured output) to classify intent — ~200ms overhead per message
3. Conversation history is stored in Postgres and displayed in the UI, but not injected into agent context in v1 — memory is a v2 feature
4. The CMO agent delegates to existing content workflow agents (`content-generator`, `content-polisher`, `content-planner`, `content-validator`, `cpo-reviewer`); other C-suite agents delegate to new executor agents defined as the system grows
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
      → Router agent classifies: { domain, mode, workflowId? }
      → Creates WorkflowRun (linked to message)
      → Enqueues BullMQ job
      → Returns { messageId, runId }

Client opens SSE connection
  → GET /api/chat/[conversationId]/stream?runId=xxx
      → Server subscribes to Redis pub/sub: chat:run:{runId}
      → Keeps connection open, forwards events as they arrive

BullMQ worker executes
  → C-suite agent fetches Notion context (scoped tools)
  → Calls LLM via Vercel AI SDK
  → Publishes to Redis: token chunks, step events, approval gates
  → On completion: persists final message to Postgres

Client renders
  → Token chunks → streaming assistant message bubble
  → workflow_step events → inline step progress cards
  → approval_needed → interactive approve/reject card
```

### SSE Event Types

| Event | Payload | UI Effect |
|---|---|---|
| `token` | `{ content: string }` | Appends to current assistant message bubble |
| `done` | `{ messageId: string }` | Finalises message, saves to DB |
| `workflow_step` | `{ stepName, status, output? }` | Renders inline step progress card |
| `approval_needed` | `{ stepOutput, workflowRunId }` | Renders approve/reject/edit buttons in thread |
| `error` | `{ message: string }` | Renders error state in thread |

## Router

A lightweight classification agent that runs before every message. Uses the `fast` LLM tier with structured output (Zod schema). Makes two decisions:

```typescript
{
  domain: "ceo" | "cpo" | "cmo" | "cfo" | "cto" | "clo" | null,
  mode: "inline" | "workflow",
  workflowId?: string  // maps to existing workflow_templates record
}
```

- **domain** — which C-suite agent owns this request. `null` = general, falls back to a broad Notion search agent
- **mode** — `inline` for read/answer tasks; `workflow` for tasks that map to an existing workflow template
- **workflowId** — populated only in workflow mode

If the user has explicitly selected an agent (via `@mention` or dropdown), the router skips domain classification and determines mode only.

## C-Suite Agents

Each agent is a standard `Agent` database record (same model as existing agents) with three additional fields:

| Field | Purpose |
|---|---|
| `role: "manager"` | Signals this is a top-level delegating agent |
| `notionScope` | JSON: which Notion databases/pages this agent can access |
| `delegatesTo` | Array of workflow template IDs or executor agent slugs |

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

**Workflow mode:**
1. Receives user message
2. Extracts structured input for the target workflow
3. Creates a `WorkflowRun` linked to the triggering `Message.workflowRunId`
4. Enqueues workflow to BullMQ — execution proceeds exactly as today
5. Publishes step progress events back to the chat thread as the workflow runs

### CMO Agent Delegation

The CMO agent wraps the existing content workflow system:

```
User: "Generate a post about our product launch"
  → Router: { domain: "cmo", mode: "workflow", workflowId: "generate-post" }
  → CMO agent parses intent → extracts { idea: "our product launch" }
  → Enqueues generate-post workflow
  → Workflow: content-generator → cpo-reviewer → [revision loop] → human_gate
  → Step events stream back into the chat thread
  → Human gate surfaces as approval card in thread
```

## Data Model

Two new tables added to the existing Postgres schema. All existing tables unchanged.

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

No changes to `workers/agent-worker.ts`, `integrations/notion/`, `auth/`, or `lib/` beyond adding a Redis pub/sub publish call in the worker's step execution loop.

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

## Error Handling

- **SSE publish failure:** Worker catches Redis errors and falls back to storing output in `workflow_steps.output` (Postgres). Client detects stalled stream and falls back to polling.
- **Router LLM failure:** Falls back to the general agent. Error logged but not surfaced to user.
- **C-suite agent LLM failure:** BullMQ retries the job (existing retry behaviour). SSE emits `error` event after max retries exceeded.
- **Notion scope access failure:** Agent returns a structured error message. User is prompted to check Notion connection in Settings.

## Testing Strategy

| Layer | What to test | How |
|---|---|---|
| Router | Correct domain + mode classification for known inputs | Mock LLM, fixed responses, verify Zod output |
| C-suite agents (inline) | Correct Notion tool calls, structured answer output | Mock Notion tools, mock LLM |
| C-suite agents (workflow mode) | Correct workflow input extraction, correct WorkflowRun creation | Mock workflow dispatch, verify enqueued payload |
| SSE streaming | Token chunks arrive in order, `done` event persists message | Integration test: real BullMQ + Redis in test env |
| Approval card | Approve/reject calls gate API, gate resolves correctly | Integration test against existing gate endpoint |
| Conversation history | Messages persisted and retrieved in correct order | Postgres integration test |
| Router fallback | Unknown intent routes to general agent gracefully | Mock router LLM to return null domain |

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
