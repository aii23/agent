# Praxis Agents — System Design

## Overview

A multi-agent platform where hierarchical manager agents collaborate to execute tasks for an internal team. Agents communicate via a custom orchestrator, execute workflows asynchronously, and integrate with Notion for knowledge and output.

## Understanding Summary

- **What:** Multi-agent platform with hierarchical orchestration and lateral agent communication
- **Why:** Automate content creation (blog, social, marketing) and planning workflows (project breakdown, sprint planning, strategy, task decomposition)
- **Who:** Internal team of 1–5 people, authenticated via EVM wallet (MetaMask/WalletConnect)
- **Key Constraints:**
  - TypeScript stack (frontend + backend)
  - Provider-agnostic LLM layer (swap OpenAI, Anthropic, local models)
  - Notion integration (read + write)
  - Self-hosted deployment
  - Async execution model
- **Non-Goals:** External client access, on-chain transactions beyond auth, real-time streaming, mobile app, multi-tenancy

## Assumptions

1. EVM wallet login is for identity/auth only — no token gating, payments, or on-chain state
2. Notion is the source of truth for company knowledge — agents read context and write deliverables back
3. The UI is a dashboard for launching workflows, reviewing results, and approving content — not a chat interface
4. Agent-to-agent communication happens server-side — users see the final result, not inter-agent conversation
5. Web UI is sufficient — no mobile app needed
6. Single company — no multi-tenancy or org-level isolation

## Architecture

```
┌─────────────────────────────────────┐
│           UI Layer (Next.js)        │
│   Wallet Auth (SIWE) + Dashboard    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│          API Layer (tRPC/REST)       │
│   Workflow triggers, status, CRUD    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│      Orchestrator (Job Dispatcher)   │
│   Accepts requests → builds agent    │
│   graph → enqueues to BullMQ         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│        Agent Runtime (Workers)       │
│   Executes agent steps, manages      │
│   inter-agent messages, calls LLMs   │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│       Integration Layer (Tools)      │
│   Notion SDK, future integrations    │
└─────────────────────────────────────┘
```

Persistence (PostgreSQL) is accessed by all layers. Redis serves BullMQ and optional LLM response caching.

## Agent Model

Each agent is a TypeScript class with:

- **Role** — what the agent does
- **System prompt** — personality, constraints, output format
- **Tools** — available integrations/actions (Notion, etc.)
- **Input schema** — typed with Zod
- **Output schema** — typed with Zod

Agents are stateless functions — they receive context, call the LLM, optionally use tools, and return a structured result. All state lives in workflow run records in Postgres.

Agent definitions live in the database (editable via UI) with code-defined defaults.

## Orchestration

A **Workflow** is a directed sequence of agent steps:

```typescript
{
  id: "blog-post",
  steps: [
    { agent: "researcher", input: "topic" },
    { agent: "writer", input: "research_output" },
    { agent: "editor", input: "draft", canRequestRevision: true },
    { agent: "human_gate", input: "edited_draft" }
  ]
}
```

Flow:
1. UI triggers a workflow
2. Orchestrator creates a workflow run record in Postgres
3. First step is enqueued to BullMQ
4. Workers execute agents, store results, enqueue next step
5. `human_gate` steps pause for user approval
6. Lateral communication via inline sub-tasks within a parent workflow run

## Authentication

1. User clicks "Connect Wallet" — MetaMask signs a SIWE message
2. Backend verifies signature, issues JWT in httpOnly cookie
3. Access control via wallet address allowlist in database
4. Simple `is_admin` flag for admin capabilities

## UI Structure

| View | Purpose |
|---|---|
| **Workflows** | Browse and launch workflow templates |
| **Runs** | Monitor active/completed runs, approve human gates |
| **Agents** | View/edit agent registry (roles, prompts, tools) |
| **Settings** | Notion OAuth, LLM provider keys, wallet allowlist |

Status updates via polling (5s interval) or lightweight WebSocket.

## Notion Integration

Connected via OAuth. Agents access Notion through typed tools:

| Tool | Description |
|---|---|
| `notion.search` | Search pages/databases by keyword |
| `notion.readPage` | Read page content as markdown |
| `notion.readDatabase` | Query database with filters |
| `notion.createPage` | Create new page in specified parent |
| `notion.updatePage` | Update existing page properties/content |
| `notion.appendBlock` | Add content blocks to a page |

Agents **never delete** Notion content. All writes are logged for auditability.

## LLM Abstraction

Vercel AI SDK provides the unified interface. Model routing by tier:

| Tier | Use Case | Example Models |
|---|---|---|
| `high` | Editor, strategist agents | claude-sonnet-4-20250514, gpt-4o |
| `standard` | Writer, researcher agents | gpt-4o-mini, claude-3.5-haiku |
| `fast` | Extraction, formatting | cheapest available |

Fallback across providers if one is down. Every call logs tokens, model, cost estimate, and parent workflow step.

## Data Model (PostgreSQL + Prisma)

| Table | Purpose |
|---|---|
| `users` | Wallet address, admin flag |
| `sessions` | JWT sessions |
| `agents` | Agent definitions (slug, role, prompt, tools, tier, schemas) |
| `workflow_templates` | Reusable workflow definitions (steps config as JSON) |
| `workflow_runs` | Execution instances (status, input, timestamps) |
| `workflow_steps` | Individual agent executions (input, output, timing) |
| `llm_calls` | Cost tracking (provider, model, tokens, cost, duration) |
| `notion_connections` | OAuth tokens (encrypted) |
| `provider_configs` | LLM API keys (encrypted) |

## Project Structure

```
agents/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/                       # Next.js App Router (UI + API)
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   └── api/
│   ├── agents/                    # Agent definitions
│   │   ├── registry.ts
│   │   ├── researcher.ts
│   │   ├── writer.ts
│   │   ├── editor.ts
│   │   ├── planner.ts
│   │   └── task-splitter.ts
│   ├── orchestrator/              # Workflow engine
│   │   ├── engine.ts
│   │   ├── router.ts
│   │   └── human-gate.ts
│   ├── workers/                   # BullMQ workers
│   │   └── agent-worker.ts
│   ├── integrations/              # External connectors
│   │   └── notion/
│   │       ├── client.ts
│   │       └── tools.ts
│   ├── auth/                      # SIWE + JWT
│   │   ├── siwe.ts
│   │   └── session.ts
│   ├── lib/                       # Shared utilities
│   │   ├── llm.ts
│   │   ├── encryption.ts
│   │   └── cost-tracker.ts
│   └── types/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env.example
```

## Deployment

Docker Compose on a self-hosted server:

| Service | Image | Purpose |
|---|---|---|
| `app` | Custom (Next.js) | UI + API + BullMQ worker |
| `postgres` | postgres:16 | Database |
| `redis` | redis:7 | Job queue |

Minimum: 2 vCPU, 4GB RAM, 40GB disk.

Worker runs in the same process initially. Split into separate `web` + `worker` containers when needed.

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | Custom monolith | LangGraph.js, Microservices | Simplest for small team, no framework lock-in, easy to self-host |
| 2 | TypeScript full stack | Python, Go | Team preference, unified language |
| 3 | Next.js App Router | Separate frontend + Express | Single deployable, SSR, co-located API |
| 4 | SIWE wallet auth | Privy, custom auth | Standard EVM auth, no third-party dependency |
| 5 | Vercel AI SDK | LangChain.js, direct API calls | Lightweight, multi-provider, TypeScript-native |
| 6 | BullMQ | pg-boss, Inngest | Mature, Redis-backed, simple API |
| 7 | Prisma ORM | Drizzle, Kysely | User preference, mature ecosystem |
| 8 | Custom orchestrator | LangGraph.js, Temporal | Full control, simpler mental model |
| 9 | Notion official SDK | Unofficial APIs | Direct integration, typed client |
| 10 | Agent defs in DB | Code-only | Edit prompts without redeployment |
| 11 | Docker Compose | K8s, cloud PaaS | Right complexity for 1–5 users |
| 12 | No Notion deletes | Full CRUD | Safety — avoid agent-caused data loss |
