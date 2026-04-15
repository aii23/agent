# 3-Day Chat Implementation Plan

## Context Summary

- **Frontend:** Complete (all UI components, layout, rendering)
- **Backend:** Greenfield — everything from zero
- **Auth:** SIWE pattern known, porting from another project
- **Notion:** Workspace exists, connection needs full implementation
- **LLM:** Anthropic key available, must be provider-agnostic (Vercel AI SDK)
- **Agents:** Router + CEO/CPO/CTO (priority) + 2 executor agents (content-creator minimum)
- **Streaming:** SSE familiar, Redis pub/sub new
- **Infra:** Local dev only, no Docker deployment needed
- **Time:** 6h/day, 18h total, AI-assisted

---

## Day 1 — Foundation & Data Pipeline (6h)

The goal: by end of day 1, you can send a message from the UI, it hits a real API, gets routed through BullMQ, an agent calls the LLM, and the response streams back to the browser via SSE. One hardcoded agent, no routing logic yet — just the full vertical slice.

### Block 1: Database & Infrastructure (2h)

| Task | Detail |
|---|---|
| Prisma schema | All tables from DESIGN.md: `users`, `sessions`, `agents`, `workflow_templates`, `workflow_runs`, `workflow_steps`, `llm_calls`, `provider_configs`, `notion_connections` + the 2 new chat tables: `conversations`, `messages` |
| Seed script | Seed a test user (hardcoded wallet address), seed one agent definition (e.g. CEO with placeholder prompt) |
| Redis + BullMQ setup | Redis connection config, BullMQ queue definition (`agent-queue`), basic worker scaffold that picks up jobs and logs them |
| SIWE auth | Port wallet auth from your other project — SIWE message signing, JWT issuance, session middleware, wallet allowlist check |

**Deliverable:** `prisma migrate dev` runs clean, BullMQ worker picks up and logs a test job, auth endpoints work.

### Block 2: LLM Abstraction & Agent Runtime (2h)

| Task | Detail |
|---|---|
| Vercel AI SDK setup | Install `ai` + `@ai-sdk/anthropic`, create `lib/llm.ts` with model tier routing (`high`/`standard`/`fast`), provider registry pattern so adding OpenAI later is one file |
| Agent base class | `agents/base.ts` — receives context (input, tools, system prompt), calls LLM via Vercel AI SDK, returns structured output. Zod input/output schemas. Streaming support via `streamText()` |
| Agent registry | `agents/registry.ts` — loads agent definitions from DB, falls back to code-defined defaults. `getAgent(slug)` returns the agent config |
| Test agent | One hardcoded CEO agent that answers general questions (no Notion yet, no routing). Just prompt + LLM call + structured response |

**Deliverable:** You can call `executeAgent("ceo", { message: "What should our Q3 priorities be?" })` and get a streamed LLM response.

### Block 3: Chat API + SSE Streaming (2h)

| Task | Detail |
|---|---|
| Conversations API | `POST /api/chat/conversations` (create), `GET /api/chat/conversations` (list with cursor pagination) |
| Messages API | `POST /api/chat/[conversationId]/messages` — creates user message record, creates a workflow run, enqueues BullMQ job, returns `{ messageId, runId }` |
| Redis pub/sub layer | `lib/redis-pubsub.ts` — `publish(channel, event)` and `subscribe(channel, callback)`. Worker publishes `token`, `done`, `error` events to `chat:run:{runId}` |
| SSE endpoint | `GET /api/chat/[conversationId]/stream?runId=xxx` — subscribes to Redis channel, pipes events to SSE response. Handles client disconnect cleanup |
| Worker integration | `workers/agent-worker.ts` — picks up BullMQ job, runs agent, publishes token chunks to Redis as they stream from the LLM, publishes `done` event, persists final message to Postgres |

**Deliverable:** Send a message in the UI → see the CEO agent's response stream in real-time in the chat thread. Full vertical slice working.

---

## Day 2 — Router, C-Suite Agents & Notion (6h)

The goal: by end of day 2, implicit routing works, 3 C-suite agents answer with real Notion context, and the workflow execution mode triggers multi-step agent chains.

### Block 4: Router Agent (1.5h)

| Task | Detail |
|---|---|
| Router agent implementation | `agents/router.ts` — uses `fast` tier, structured output via Zod: `{ domain, mode, workflowId? }`. System prompt with classification rules |
| `@mention` parsing | Parse `@CEO`, `@CPO`, etc. from message text. If present, skip domain classification, determine mode only |
| `Conversation.agentSlug` | Respect pinned agent from dropdown. Override logic: pinned < `@mention` |
| Router fallback | If domain is `null`, route to a general agent that searches all Notion scopes |
| Wire into message API | `POST /api/chat/[conversationId]/messages` now runs router before enqueuing, passes `{ domain, mode }` to the BullMQ job payload |

**Deliverable:** Type "What's our product roadmap?" → router classifies as CPO domain → CPO agent handles it. Type "@CEO summarize our strategy" → CEO agent handles regardless of router.

### Block 5: Notion Integration (1.5h)

| Task | Detail |
|---|---|
| Notion OAuth flow | Settings page endpoint: `GET /api/notion/auth` (redirect to Notion OAuth), `GET /api/notion/callback` (exchange code for token, encrypt, store in `notion_connections`) |
| Notion client | `integrations/notion/client.ts` — initialized with decrypted OAuth token. Handles token refresh |
| Notion tools | `integrations/notion/tools.ts` — implement all 6 tools from DESIGN.md: `search`, `readPage`, `readDatabase`, `createPage`, `updatePage`, `appendBlock`. Each tool is a typed function the agent runtime can call |
| Notion scope enforcement | Agent definition has `notionScope` JSON. Tool calls are filtered — agent can only access pages/databases listed in its scope |

**Deliverable:** CEO agent can search and read Notion strategy pages. Notion scope restricts what each agent sees.

### Block 6: C-Suite Agents — CEO, CPO, CTO (2h)

| Task | Detail |
|---|---|
| Agent definition pattern | Finalize the DB schema for manager agents: `role: "manager"`, `notionScope`, `delegatesTo`. Seed all 3 agents with their Notion scopes from the design doc |
| CEO agent | System prompt tuned for strategy, roadmap, OKRs. Notion scope: strategy pages, roadmap, OKRs, meeting notes. Inline mode: searches Notion, synthesizes answer |
| CPO agent | System prompt for product management. Notion scope: product specs, task databases, sprint pages. Inline mode: product questions with Notion context |
| CTO agent | System prompt for technical decisions. Notion scope: technical docs, architecture pages, eng tasks. Inline mode: technical questions with Notion context |
| Inline mode execution | Wire the agent worker to handle `mode: "inline"` — agent receives message, calls scoped Notion tools, calls LLM, streams response |

**Deliverable:** All 3 C-suite agents answer questions using real Notion data. Each agent only sees its designated Notion scope.

### Block 7: Workflow Mode & Orchestrator (1h)

| Task | Detail |
|---|---|
| Orchestrator engine | `orchestrator/engine.ts` — takes a workflow template (array of steps), creates a `WorkflowRun`, executes steps sequentially via BullMQ. Each step enqueues the next on completion |
| Workflow templates | Seed at least one workflow template: `generate-post` (content-generator → cpo-reviewer → human_gate) |
| Workflow mode in chat | When router returns `mode: "workflow"`, the C-suite agent extracts structured input, creates a WorkflowRun linked to the message, enqueues the first step |
| Step events in SSE | Worker publishes `workflow_step` events (`{ stepName, status, output? }`) to the Redis channel. Client renders inline step progress cards |

**Deliverable:** "Generate a post about our product launch" → router picks workflow mode → orchestrator runs multi-step workflow → step progress cards appear inline in chat.

---

## Day 3 — Executor Agents, Human Gates, Polish & Edge Cases (6h)

The goal: by end of day 3, the full loop works — including content creation agents, human approval inline in chat, error handling, conversation management, and all edge cases from the design doc.

### Block 8: Executor Agents (2h)

| Task | Detail |
|---|---|
| Content Generator agent | `agents/content-generator.ts` — receives topic/idea, uses Notion context (brand voice, content calendar), generates draft content. `standard` LLM tier |
| Content Polisher agent | `agents/content-polisher.ts` — receives draft, improves quality, checks brand consistency. Outputs polished version |
| CPO Reviewer agent | `agents/cpo-reviewer.ts` — reviews content from product perspective, can request revision (triggers loop back to content-generator) |
| Revision loop | Orchestrator handles `canRequestRevision: true` — if reviewer output contains revision request, re-enqueue the writer step with feedback |
| Agent seeding | Seed all executor agents in DB with prompts, schemas, tool access, and LLM tier assignments |

**Deliverable:** Full content generation workflow runs: generate → polish → review → (optional revision loop) → human gate.

### Block 9: Human Gates in Chat (1h)

| Task | Detail |
|---|---|
| Human gate step | `orchestrator/human-gate.ts` — pauses workflow execution, publishes `approval_needed` event via Redis with step output and runId |
| Gate API | `POST /api/workflows/[runId]/gate` — accepts `approve`, `reject`, or `edit` action. Idempotent (second call returns current state). Shared between Chat and Runs tab |
| Chat UI wiring | `approval_needed` SSE event renders the interactive approve/reject/edit card already built in the UI. Approve calls gate API, workflow resumes |
| Edit flow | "Edit" opens the content in an editable field inline. Submit sends edited content as the gate output, workflow continues with modified content |

**Deliverable:** Workflow pauses at human gate → approval card appears in chat → approve/reject/edit works → workflow resumes or stops.

### Block 10: Conversation Management & UI Wiring (1.5h)

| Task | Detail |
|---|---|
| Conversation CRUD | List conversations (grouped by Today/Yesterday/Older), create new, delete, rename title |
| Auto-title generation | On first user message, fire a `fast` tier LLM call to generate ~40 char title. Store on `Conversation.title` |
| Conversation sidebar wiring | Connect sidebar to `GET /api/chat/conversations` with cursor-based pagination |
| Agent selector wiring | Dropdown updates `Conversation.agentSlug` via PATCH. Per-message `@mention` override parsed and passed to router |
| Message history loading | `GET /api/chat/[conversationId]/messages` with cursor-based pagination. Virtualized scroll for 100+ messages |
| SSE reconnection | On disconnect, client reconnects and replays missed events. Catch-up via polling `workflow_steps` with `?after=lastEventTimestamp` |

**Deliverable:** Full conversation management — create, list, rename, delete, paginate. Agent selector works. SSE reconnection handles drops.

### Block 11: Error Handling & Edge Cases (1.5h)

| Task | Detail |
|---|---|
| SSE publish failure | Worker catches Redis publish errors, falls back to storing output in `workflow_steps.output`. Client detects stalled stream, falls back to polling |
| Router LLM failure | Falls back to general agent. Error logged, not surfaced to user |
| Agent LLM failure | BullMQ retry config (3 retries, exponential backoff). After max retries, SSE emits `error` event |
| Notion scope failure | Agent returns structured error: "Couldn't find relevant information." No hallucination |
| Cross-tab approval | Approve in Runs tab or Chat — both hit same gate API, idempotent |
| Pre-SSE message send | Client polls `workflow_steps` for runId on mount as catch-up if SSE wasn't connected when the job started |
| Provider config encryption | `lib/encryption.ts` — AES-256 encryption for API keys and Notion tokens stored in DB |
| Cost tracking | `llm_calls` table populated on every LLM call: provider, model, tokens in/out, cost estimate, parent step ID |

**Deliverable:** System handles all edge cases from the design doc. Errors are graceful, not catastrophic. Cost tracking works.

---

## Summary

| Day | Theme | Key Deliverable |
|---|---|---|
| **1** | Foundation | Send message → LLM response streams back in chat. Full vertical slice with auth, DB, BullMQ, SSE |
| **2** | Intelligence | Router classifies intent, 3 C-suite agents answer with Notion context, workflow mode triggers multi-step chains |
| **3** | Completion | Executor agents, human gates inline, conversation management, error handling, all edge cases |

Each day builds on the previous. Day 1 is the skeleton you can't skip. Day 2 makes it smart. Day 3 makes it complete.
