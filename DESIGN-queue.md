# Agent Queue & Worker Design

## Overview

This document covers the worker execution engine — how a user message becomes an
orchestrated sequence of agent calls (manager plans → executors run sequentially →
manager synthesizes) with the final result written back to the conversation.

---

## Understanding Summary

- **What:** Implementation of the BullMQ worker replacing the existing stub — three
  phase handlers (plan, execute, synthesize) backed by DB state
- **Why:** To execute multi-step agent workflows driven by a manager agent's
  LLM-generated plan, with executor outputs chaining into subsequent steps
- **Who:** Internal team, 1–5 users, no scale pressure
- **Key constraints:** TypeScript, BullMQ, Vercel AI SDK, Prisma/Postgres, Redis,
  2-level max (manager → executors only, no recursive delegation)
- **Non-goals (this document):** Parallel executor execution, human gate steps,
  real-time streaming to UI, cost tracking

---

## Job Types & Payloads

Three typed jobs replace the existing single `AgentJobData`. All go into the same
`agent-queue`; one Worker instance handles all three job names via internal dispatch.

```typescript
// "manager.plan" — triggered by conversations.addMessage
interface ManagerPlanJob {
  conversationId: string
  messageId: string   // the user message that triggered this run
  agentSlug: string   // which manager agent to use
}

// "executor.run" — triggered by manager.plan or previous executor.run
interface ExecutorRunJob {
  executionPlanId: string
  stepIndex: number
}

// "manager.synthesize" — triggered by the last executor.run
interface ManagerSynthesizeJob {
  executionPlanId: string
}
```

Worker dispatcher (thin — all logic lives in `orchestrator/`):

```typescript
async function processAgentJob(job: Job) {
  switch (job.name) {
    case "manager.plan":       return handleManagerPlan(job.data)
    case "executor.run":       return handleExecutorRun(job.data)
    case "manager.synthesize": return handleManagerSynthesize(job.data)
  }
}
```

`conversations.addMessage` enqueues `"manager.plan"` (replacing current `"agent.run"`).

---

## DB Schema

```prisma
model ExecutionPlan {
  id               String              @id @default(uuid())
  conversationId   String
  messageId        String              // triggering user message
  managerSlug      String
  status           ExecutionPlanStatus
  steps            Json                // PlanStep[] — raw templates from LLM
  currentStepIndex Int                 @default(0)
  managerThread    Json?               // Message[] — saved LLM thread for synthesis
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt
  workflowSteps    WorkflowStep[]
}

enum ExecutionPlanStatus {
  PLANNING EXECUTING SYNTHESIZING DONE FAILED
}

model WorkflowStep {
  id              String      @id @default(uuid())
  executionPlanId String
  stepIndex       Int
  agentSlug       String
  resolvedPrompt  String      // prompt after template vars are substituted
  output          String?     // null until complete
  status          StepStatus
  createdAt       DateTime    @default(now())
  completedAt     DateTime?
  plan            ExecutionPlan @relation(fields: [executionPlanId], references: [id])
}

enum StepStatus { PENDING RUNNING DONE FAILED }
```

The `steps` JSON is the manager's LLM-generated plan:

```json
[
  { "agent": "researcher", "promptTemplate": "Research: {{userRequest}}" },
  { "agent": "writer",     "promptTemplate": "Write based on: {{steps[0].output}}" }
]
```

Template variables resolved at execution time:
- `{{userRequest}}` — the original user message
- `{{steps[N].output}}` — the output of a prior completed step

---

## Handler Flows

### `handleManagerPlan`

```
1. Load agent from DB (by slug) — systemPrompt, model, delegatesTo
2. Load conversation messages — build LLM context
3. Call LLM with generateObject → { steps: PlanStep[] }
4. Validate: reject any step whose agent slug is not in delegatesTo (allowlist)
5. Save ExecutionPlan {
     status: EXECUTING,
     steps,
     managerThread: [system, user, assistant]  ← full planning conversation saved
   }
6. Enqueue "executor.run" { executionPlanId, stepIndex: 0 }
```

### `handleExecutorRun`

```
1. Load ExecutionPlan + all DONE WorkflowSteps for this plan
2. Get steps[stepIndex] — { agent, promptTemplate }
3. Load executor agent from DB
4. Resolve template: substitute {{userRequest}} and {{steps[N].output}}
5. Create WorkflowStep { resolvedPrompt, status: RUNNING }
6. Call LLM with resolved prompt → output
7. Update WorkflowStep { output, status: DONE, completedAt }
8. If stepIndex + 1 < steps.length:
     → enqueue "executor.run" { stepIndex + 1 }
   Else:
     → update ExecutionPlan { status: SYNTHESIZING }
     → enqueue "manager.synthesize" { executionPlanId }
```

### `handleManagerSynthesize`

```
1. Load ExecutionPlan + manager agent + all DONE WorkflowSteps
2. Load managerThread (saved planning conversation)
3. Append new user message to thread: all executor outputs formatted as context
4. Call LLM with full reconstructed thread → final response
5. Write Message { role: ASSISTANT, content: response, status: DONE } to conversation
6. Update ExecutionPlan { status: DONE }
```

The manager's synthesis LLM call sees one continuous conversation — its own planning
reasoning plus executor results appended — so it synthesizes coherently without
re-explaining the original request.

---

## Error Handling

**Principle:** any failure at any phase must write a visible error message to the
conversation. Users must never be left with a message stuck in `PENDING`.

| Failure | Action |
|---|---|
| `manager.plan` LLM fails | `ExecutionPlan { FAILED }` + error assistant message |
| Allowlist violation in plan | Reject plan immediately + error assistant message |
| `executor.run` fails | BullMQ retries 3× (exponential backoff, already configured). After exhaustion: `WorkflowStep { FAILED }`, `ExecutionPlan { FAILED }`, error assistant message |
| `manager.synthesize` fails | `ExecutionPlan { FAILED }` + error assistant message |

---

## File Structure

```
lib/
  queue.ts              ← updated: three typed job names + enqueue helpers

orchestrator/
  plan.ts               ← handleManagerPlan
  execute.ts            ← handleExecutorRun + resolveTemplate()
  synthesize.ts         ← handleManagerSynthesize

workers/
  agent-worker.ts       ← thin: Worker instance + switch dispatch

prisma/
  schema.prisma         ← add ExecutionPlan, WorkflowStep, enums
```

---

## UI Updates

Polling (existing chat refresh interval) is sufficient for 1–5 users. The worker
writes the final `Message` record to Postgres; the UI picks it up on the next poll.

SSE (Redis pub/sub → Next.js route handler → client) is the planned upgrade path for
real-time delivery.

---

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | Sequential execution, outputs chain | Parallel execution | Step N+1 prompt may reference step N output — requires serial ordering |
| 2 | DB-backed state, jobs carry IDs only | Full payload in job | DB is queryable (UI can show progress), retries are safe (idempotent re-load) |
| 3 | Three separate job names | Single job + `phase` field | Clean separation, typed payloads per phase, readable BullMQ dashboard |
| 4 | Polling for UI updates | SSE, WebSocket | Sufficient for internal tool at this scale; SSE deferred as upgrade |
| 5 | Manager thread saved at plan time, loaded at synthesis | Re-send full context at synthesis | LLM sees continuous reasoning chain without re-explaining the original request |
| 6 | Any failure writes error message to conversation | Silent fail / status-only | User always gets feedback; no stuck PENDING messages |
