# Content Agent System — Design Document

## Understanding Summary

- **What:** A set of content workflows built on the Praxis agent platform — chaining specialized agents to handle social media content creation, editing, planning, and validation for Twitter/X
- **Why:** Automate the content lifecycle from idea to publishable post, with AI-driven quality control (CPO agent) to reduce manual review burden on a small team
- **Who:** Internal team of 1–5 people, same audience as the broader Praxis platform
- **Key Constraints:**
  - Twitter/X is the sole target platform (280 char limit, thread support)
  - Brand voice is encoded in agent system prompts (editable via UI)
  - Notion is the source of truth for content plans and final posts; dashboard provides visibility
  - CPO agent is a mandatory blocking gate on all outputs
  - Rejected content gets one auto-revision, then escalates to human
- **Non-Goals:** Multi-platform posting, direct Twitter API integration, image/media generation, analytics/engagement tracking

## Assumptions

1. A "content plan" is a week-long schedule: which topics go on which days, with optional notes per entry
2. The CPO agent uses a `high` tier model (claude-sonnet-4-20250514 / gpt-4o) since it's the final quality gate
3. Content generation agents use `standard` tier — good enough for drafts that will be reviewed
4. The content plan is stored as a Notion database (rows = posts, columns = date, topic, status, copy, platform)
5. The CPO agent evaluates against criteria in its system prompt — no external scoring API
6. Thread support (multi-tweet posts) is in scope but single tweets are the primary unit
7. The "validate existing content plan" workflow reads a plan already in Notion and produces a review/feedback document

## Agents

### `content-polisher`

- **Role:** Edit/polish a human-written Twitter/X post
- **Input:** `{ text: string }`
- **Output:** `{ polished: string, changes: string[] }`
- **Tools:** None
- **Tier:** `standard`
- **Prompt focus:** Twitter/X conventions, conciseness, preserve author voice, fix grammar/tone, stay within 280 chars (or flag if thread is needed)

### `content-generator`

- **Role:** Generate a Twitter/X post from a rough idea
- **Input:** `{ idea: string, notionPageId?: string }`
- **Output:** `{ post: string, thread?: string[] }`
- **Tools:** `notion.readPage` (only when `notionPageId` is provided)
- **Tier:** `standard`
- **Prompt focus:** Distill ideas into punchy Twitter/X copy, brand voice, 280 char limit, optional thread structure

### `content-planner`

- **Role:** Distribute topics across a 7-day schedule
- **Input:** `{ topics: string[], startDate: string }`
- **Output:** `{ plan: Array<{ date: string, topic: string, notes: string }> }`
- **Tools:** `notion.createPage` / `notion.updatePage`
- **Tier:** `standard`
- **Prompt focus:** Even distribution, variety, logical sequencing, leave room for rest days

### `content-validator`

- **Role:** Review an existing content plan for quality
- **Input:** `{ notionDatabaseId: string }`
- **Output:** `{ approved: boolean, issues: Array<{ date: string, issue: string, suggestion: string }> }`
- **Tools:** `notion.readDatabase`
- **Tier:** `standard`
- **Prompt focus:** Check consistency (no duplicates, good variety), tone alignment, feasibility (cadence is realistic)

### `cpo-reviewer`

- **Role:** Final quality gate — reviews any content output and approves or rejects with feedback
- **Input:** `{ type: "post" | "plan", content: object, context?: string }`
- **Output:** `{ approved: boolean, feedback?: string, severity?: "minor" | "major" }`
- **Tools:** None
- **Tier:** `high`
- **Evaluation criteria:**

| Criterion | What it checks |
|---|---|
| Brand alignment | Does it match the voice defined in content agent prompts? |
| Platform fit | Twitter/X conventions — length, tone, readability |
| Clarity | Is the message clear without insider context? |
| Consistency | (Plans) No duplicates, good variety, realistic cadence |
| Feasibility | (Plans) Not overloaded, sustainable posting rhythm |
| Relevance | Does the output actually address the original request? |

- **Revision behavior:**
  - `severity: "minor"` → originating content agent auto-revises using CPO feedback
  - `severity: "major"` → escalate directly to human gate
  - Second rejection (any severity) → escalate to human gate
  - Worst case path: agent → CPO (reject) → agent retry → CPO (reject) → human

## Workflow Templates

### `polish-post`

```
User submits raw post text
  → content-polisher
    → cpo-reviewer (type: "post")
      → [revision loop if rejected]
        → human_gate
          → notion write (Content Calendar)
```

```typescript
{
  id: "polish-post",
  steps: [
    { agent: "content-polisher", input: "user_text" },
    { agent: "cpo-reviewer", input: "polisher_output", canRequestRevision: true, maxRevisions: 1 },
    { agent: "human_gate", input: "approved_post" },
    { agent: "notion-writer", input: "final_post" }
  ]
}
```

### `generate-post`

```
User submits idea (paragraph or Notion page ref)
  → content-generator
    → cpo-reviewer (type: "post")
      → [revision loop if rejected]
        → human_gate
          → notion write (Content Calendar)
```

```typescript
{
  id: "generate-post",
  steps: [
    { agent: "content-generator", input: "user_idea" },
    { agent: "cpo-reviewer", input: "generator_output", canRequestRevision: true, maxRevisions: 1 },
    { agent: "human_gate", input: "approved_post" },
    { agent: "notion-writer", input: "final_post" }
  ]
}
```

### `create-content-plan`

```
User submits list of topics + start date
  → content-planner (writes draft plan to Notion)
    → cpo-reviewer (type: "plan")
      → [revision loop if rejected]
        → human_gate
          → notion update (finalize status to "active")
```

```typescript
{
  id: "create-content-plan",
  steps: [
    { agent: "content-planner", input: "user_topics" },
    { agent: "cpo-reviewer", input: "planner_output", canRequestRevision: true, maxRevisions: 1 },
    { agent: "human_gate", input: "approved_plan" },
    { agent: "notion-writer", input: "finalized_plan" }
  ]
}
```

### `validate-content-plan`

```
User points to existing Notion content calendar
  → content-validator (reads from Notion, produces review)
    → cpo-reviewer (type: "plan")
      → human_gate (user sees issues + suggestions)
```

```typescript
{
  id: "validate-content-plan",
  steps: [
    { agent: "content-validator", input: "notion_database_id" },
    { agent: "cpo-reviewer", input: "validator_output" },
    { agent: "human_gate", input: "review_report" }
  ]
}
```

No revision loop — this workflow is read-only and advisory.

## Notion Content Calendar Schema

| Property | Type | Purpose |
|---|---|---|
| `Title` | Title | Post topic or headline |
| `Status` | Select: `draft`, `in-review`, `approved`, `published` | Lifecycle tracking |
| `Date` | Date | Scheduled publish date |
| `Platform` | Select: `twitter` | Target platform (extensible) |
| `Copy` | Rich text | The actual post text |
| `Thread` | Rich text | Thread tweets if applicable |
| `Source` | Select: `human`, `generated`, `polished` | How the post was created |
| `Workflow Run` | Text | Praxis workflow run ID for traceability |
| `CPO Notes` | Rich text | Feedback from CPO reviewer |

## Data Flow

| Workflow | Reads from Notion | Writes to Notion |
|---|---|---|
| `polish-post` | Nothing | Creates row: `status: approved`, `source: polished` |
| `generate-post` | Optional page via `notionPageId` | Creates row: `status: approved`, `source: generated` |
| `create-content-plan` | Nothing | Creates rows: `status: draft` → updates to `approved` |
| `validate-content-plan` | Reads existing Content Calendar rows | No writes — feedback in workflow run output only |

## Edge Cases

| Case | Handling |
|---|---|
| Post exceeds 280 chars | Agents check length; output as `thread` if unavoidable. CPO rejects single posts over 280 chars. |
| Empty or nonsensical input | Agents return structured error with suggestion. Workflow surfaces to user. |
| More topics than days | Planner distributes multiple posts/day or suggests dropping lower-priority topics. CPO checks feasibility. |
| 0 or 1 topics submitted | Planner returns minimal plan or error suggesting more topics. |
| CPO/agent disagreement loop | Hard cap: max 1 auto-revision. Second rejection always goes to human. |
| Notion OAuth expired | Tool calls fail gracefully. User prompted to re-auth in Settings. |
| Duplicate post detection | Out of scope for v1. CPO prompt includes soft check only. |

## Error Handling

- Notion API write failures: BullMQ retries. Post/plan stored in `workflow_steps.output` (Postgres) as fallback.
- Unparseable CPO response: Step retries once. If still broken, escalates to human gate with raw content + error note.

## Testing Strategy

| Layer | What to test | How |
|---|---|---|
| Agent unit tests | Each agent produces valid output for known inputs | Mock LLM (fixed responses), verify Zod schema validation |
| CPO approval logic | Approval/rejection paths, severity mapping, revision triggering | Mock CPO responses, verify workflow routing |
| Workflow integration | Full end-to-end flow from trigger to Notion write | BullMQ test harness with mocked agents, verify step ordering |
| Notion integration | Read/write operations produce correct structure | Integration tests against Notion test workspace |
| Revision loop | Auto-revision once, then escalates | Mock CPO to reject twice, verify human gate triggered |
| Error paths | Bad input, Notion failures, unparseable LLM output | Inject failures, verify graceful degradation |

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | Four specialized content agents + CPO | Single mode-switching agent; reuse existing writer/editor | Focused prompts are easier to tune and debug. Existing agents are designed for blog posts, not Twitter/X. |
| 2 | CPO as mandatory blocking gate | Async reviewer; CPO only for plans | Ensures consistent quality on all outputs. Small team can't afford to publish bad content. |
| 3 | One auto-revision, then human escalation | Unlimited retries; no auto-revision | Bounded loop prevents runaway costs. One retry catches most minor issues without human involvement. |
| 4 | Severity-based revision routing | Flat reject/approve only | Major issues (wrong topic, off-brand) shouldn't waste a revision attempt — go straight to human. |
| 5 | Twitter/X only for v1 | Multi-platform from day one | YAGNI. Single platform simplifies prompts and constraints. Platform field in Notion is extensible. |
| 6 | Brand voice in system prompts | Notion brand guide page; separate config | Simplest option. Editable via Agents UI. No runtime lookup overhead. |
| 7 | Content Calendar as single Notion database | Separate databases per workflow; Postgres-only storage | Notion is the agreed source of truth. Single database keeps all content visible in one place. |
| 8 | Validate workflow is read-only + advisory | Validator auto-fixes the plan | Users should decide what to change. Auto-fixing a plan they authored feels presumptuous. |
