import { generateText, Output } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { enqueueExecutorRun } from "@/lib/queue";
import type { ManagerPlanJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";
import {
  getNotionIndex,
  formatNotionIndex,
  type NotionScope,
} from "@/lib/notion-index";
import { buildNotionContext } from "@/orchestrator/context";
import { CACHE_BREAKPOINT } from "@/lib/llm-cache";
import { buildBoundedHistory } from "@/lib/conversation-history";

import { config } from "dotenv";
config({ path: ".env.local" });

// ── Schemas ────────────────────────────────────────────────────────────────

const PlanStepSchema = z.object({
  agent: z.string(),
  promptTemplate: z.string(),
});

// Note: .min()/.max() on arrays emit minItems/maxItems in JSON schema which
// Anthropic's structured output rejects. Enforce limits in code after parsing.
const ExecutionPlanSchema = z.object({
  steps: z.array(PlanStepSchema),
  synthesisRequired: z
    .boolean()
    .describe(
      "Set false when the FINAL executor's output is itself the deliverable the user asked for (a polished tweet, a written email, a finished spec) and synthesis would only reformat it. Set true when multiple executor outputs need merging, when judgement / trade-offs must be added, or when the user asked for a recommendation rather than an artifact. Default to false for single-step plans whose last step already produces the requested artifact.",
    ),
  synthesisPrompt: z
    .string()
    .describe(
      "A specific instruction for the synthesis step. Must include the literal placeholder {{executorResults}} exactly once — that token will be replaced with the concatenated executor outputs at synthesis time. The prompt should reference the user's goal, describe the desired output format (length, tone, structure, what to lead with), and explain how to weigh or combine the results. Do not be generic. " +
        "IMPORTANT: the synthesizer does NOT see your persona prompt or this planner block. This synthesisPrompt is the entire brief it gets, alongside the conversation history and the executor outputs. Bake all the manager-specific guidance you want it to follow into THIS string. " +
        "Do NOT instruct the synthesizer to 'route to', 'send to', or 'have X review' — there are no follow-up steps after synthesis. " +
        "Required even when synthesisRequired is false (used as a fallback formatter hint).",
    ),
});

// Schema for the context-request step: which Notion pages are relevant?
const ContextRequestSchema = z.object({
  pageIds: z.array(z.string()),
});

type PlanStep = z.infer<typeof PlanStepSchema>;

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleManagerPlan(
  data: ManagerPlanJobData,
): Promise<void> {
  const { conversationId, messageId, agentSlug } = data;

  // 1. Load manager agent
  console.log("1. Loading manager agent", agentSlug);
  const agent = await prisma.agent.findUnique({
    where: { slug: agentSlug },
    include: {
      delegatesTo: { select: { slug: true, name: true, role: true } },
    },
  });

  if (!agent) throw new Error(`Agent not found: ${agentSlug}`);

  // 2. Load conversation history for LLM context
  console.log("2. Loading conversation history", conversationId);
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!conversation)
    throw new Error(`Conversation not found: ${conversationId}`);

  const userMessage = conversation.messages.find((m) => m.id === messageId);
  if (!userMessage) throw new Error(`Message not found: ${messageId}`);

  // Build a bounded, cleaned prior-message slice (drops STREAMING/FAILED rows,
  // caps to recent turns, marks last message as Anthropic cache breakpoint).
  const priorMessages: ModelMessage[] = buildBoundedHistory(
    conversation.messages,
    messageId,
  );

  const availableExecutors = agent.delegatesTo
    .map((e) => `- ${e.slug}: ${e.role}`)
    .join("\n");

  // ── Phase A: Build Notion context ─────────────────────────────────────────
  // Step A1 — Load the catalog scoped to THIS agent's notionScope (per design).
  //           No raw page content fetched yet, no LLM call.
  console.log("3. Loading Notion workspace catalog (scoped)");
  const notionScope =
    (agent.notionScope as NotionScope | null | undefined) ?? undefined;
  const pageIndex = await getNotionIndex(notionScope);
  const catalogText = formatNotionIndex(pageIndex);

  let selectedPageIds: string[] = [];
  let notionContext = "";

  if (pageIndex.length > 0) {
    // Step A2 — Ask a cheap model which pages are relevant to this request.
    //           The model sees only summaries (< 10 tokens/page), not full content.
    console.log(
      `4. Selecting relevant Notion pages from catalog (${pageIndex.length} pages)`,
    );
    try {
      // No cachedSystem here — the system prompt is ~150 tokens, well below
      // Anthropic's 2048-token Haiku cache minimum, so the breakpoint would
      // be ignored. Keeping the call simple.
      const contextRequest = await generateText({
        model: resolveModel("claude-haiku"),
        system: `You are a context selection assistant for an AI agent system.
Given a user request and a catalog of Notion workspace pages (each with an ID, breadcrumb path, and one-sentence summary), select the IDs of pages that contain information genuinely useful for completing the request.
Return an empty array if no pages are relevant.
Do not include pages just because they sound related — only include pages whose content will meaningfully improve the agent's response.`,
        prompt: `User request: "${userMessage.content}"\n\nAvailable pages:\n${catalogText}`,
        output: Output.object({ schema: ContextRequestSchema }),
      });

      selectedPageIds = contextRequest.output.pageIds;
      console.log(
        `[plan:context] selected ${selectedPageIds.length} pages:`,
        selectedPageIds,
      );
    } catch (err) {
      // Context selection is best-effort — plan without context rather than fail
      console.warn(
        "[plan:context] Page selection failed, proceeding without context:",
        (err as Error).message,
      );
    }

    // Step A3 — Fetch and compress the full content of selected pages.
    //           buildNotionContext does a second relevance pass at compression time.
    if (selectedPageIds.length > 0) {
      console.log("5. Building Notion context from selected pages");
      try {
        notionContext = await buildNotionContext(
          selectedPageIds,
          userMessage.content,
        );
        console.log(
          `[plan:context] context built — ${notionContext.length} chars`,
        );
      } catch (err) {
        console.warn(
          "[plan:context] Context build failed, proceeding without context:",
          (err as Error).message,
        );
      }
    }
  }

  // ── Phase B: Generate execution plan ──────────────────────────────────────

  // Stable, cacheable system block: persona + executor list + planner rules.
  // Crucially, Notion context is NOT here — it changes per turn and would
  // invalidate the cache on every request.
  const stableSystemPrompt = `${agent.systemPrompt}

You have access to the following executor agents:
${availableExecutors}

When responding, produce an execution plan as a structured list of steps, plus synthesisRequired and synthesisPrompt.

Steps:
- Each step must reference one of the executor agents listed above.
- Use {{userRequest}} in promptTemplate to refer to the user's request.
- Use {{notionContext}} in promptTemplate to inject the workspace context into an executor prompt.
- Use {{steps[N].output}} to reference the output of a previous step (0-indexed).
- Maximum 8 steps.

Tool agent rules (web-search, web-fetch):
- web-search promptTemplate must be only the search query string — no extra text.
  ✓ "Maven 11 Capital VC fund investment focus contacts"
  ✗ "Search the web for Maven 11 Capital and return their contact details"
- web-fetch promptTemplate must be only the URL — no instructions, no surrounding text.
  ✓ "https://www.maven11.com"
  ✗ "Fetch https://www.maven11.com and extract investment focus and contact details"
  The extraction instructions belong in the downstream researcher or writer step, not here.
- To chain web-search into web-fetch, use {{steps[N].output}} as the entire web-fetch promptTemplate — the engine will pick the top-scored URL automatically.

synthesisRequired:
- false when the final executor's output IS the deliverable (polished tweet, written email, finished spec) — the orchestrator will publish it directly with light formatting.
- true when multiple executor outputs must be merged, judgement added, or a recommendation framed.

synthesisPrompt:
- This is the ONLY brief the synthesizer agent receives, alongside conversation history and executor outputs. The synthesizer does NOT see your persona prompt or these planner instructions.
- Bake everything turn-specific into this string: format, length, tone, structure, what to lead with, what to weigh, what to omit. Pull guidance from your "How to synthesize" section into the synthesisPrompt itself when relevant.
- Always provide one (used as the formatter hint even when synthesisRequired is false).
- Include the placeholder {{executorResults}} exactly once — it will be replaced with the concatenated outputs of all executor steps.
- Reference the user's original goal and the expected shape of the final response.
- Do NOT instruct the synthesizer to "route to", "send to", or "have X review" — there are no follow-up steps after synthesis. Any reviewer/editor work must be a real plan step, not a synthesis instruction.
- Do not write a generic "please summarise" instruction — make it specific to this request.`;

  // Multi-block system: Notion context FIRST (its own cache breakpoint),
  // then the stable persona+instructions block. Putting the largest shared
  // blob first means:
  //   - Within a plan: every executor call (separate file) shares the same
  //     notion_context prefix → cross-executor cache hits.
  //   - Across turns to this manager: when the planner picks the same pages
  //     and the compressor produces similar output, BP1 still hits even if
  //     the persona/instructions block ever changes.
  // BP2 (after the persona block) covers the always-stable suffix.
  const messages: ModelMessage[] = [];

  if (notionContext) {
    messages.push({
      role: "system",
      content: `<workspace_context>\n${notionContext}\n</workspace_context>`,
      providerOptions: CACHE_BREAKPOINT,
    });
  }

  messages.push({
    role: "system",
    content: stableSystemPrompt,
    providerOptions: CACHE_BREAKPOINT,
  });

  messages.push(
    ...priorMessages,
    { role: "user", content: userMessage.content },
  );

  let plan: {
    steps: PlanStep[];
    synthesisPrompt: string;
    synthesisRequired: boolean;
  };

  try {
    // 6. Call LLM to generate execution plan
    //
    // Planning runs on agent.model (Sonnet for managers). Tempting to flip
    // this to Haiku — plan output is JSON-shaped and feels like simple
    // structured output — but the actual task is harder than it looks:
    //   - pick the right executor from ~20 candidates with subtle differences
    //   - write promptTemplates that pass the right constraints downstream
    //   - hold the "shortest plan that does the job" line (a soft rule
    //     Sonnet weighs noticeably better than Haiku)
    //   - decide synthesisRequired correctly
    // The downstream cost of a bad plan (one extra executor step ≈ +$0.02)
    // wipes out the planner savings. Revisit this only with measurement
    // (per-call token logs + plan-quality eval), not on intuition.
    const resolvedModel = resolveModel(agent.model);

    // ── DEBUG: env & model resolution ─────────────────────────────────────
    console.log("[plan:debug] agent.model key   :", agent.model);
    console.log(
      "[plan:debug] resolved model id  :",
      (resolvedModel as any).modelId ?? resolvedModel,
    );
    console.log(
      "[plan:debug] ANTHROPIC_API_KEY  :",
      process.env.ANTHROPIC_API_KEY
        ? `set (${process.env.ANTHROPIC_API_KEY.slice(0, 12)}…)`
        : "MISSING",
    );
    console.log(
      "[plan:debug] AI_GATEWAY_API_KEY :",
      process.env.AI_GATEWAY_API_KEY
        ? `set (${process.env.AI_GATEWAY_API_KEY.slice(0, 12)}…)`
        : "not set",
    );
    console.log("[plan:debug] messages count     :", messages.length);
    console.log(
      "[plan:debug] stableSystem len   :",
      stableSystemPrompt.length,
    );
    console.log("[plan:debug] notionContext len  :", notionContext.length);
    // ──────────────────────────────────────────────────────────────────────

    console.log("6. Calling LLM to generate execution plan");
    const result = await generateText({
      model: resolvedModel,
      // System blocks live in the messages array (see above) so we can put
      // notion context FIRST with its own cache breakpoint. Don't also pass
      // `system:` — it'd insert a third system block and confuse the cache.
      messages,
      output: Output.object({ schema: ExecutionPlanSchema }),
    });

    // ── DEBUG: response surface ────────────────────────────────────────────
    console.log("[plan:debug] finishReason       :", result.finishReason);
    console.log(
      "[plan:debug] usage              :",
      JSON.stringify(result.usage),
    );
    console.log(
      "[plan:debug] raw output         :",
      JSON.stringify(result.output),
    );
    // ──────────────────────────────────────────────────────────────────────

    plan = result.output;

    if (plan.steps.length === 0) {
      throw new Error("Plan has 0 steps — LLM returned an empty plan.");
    }
    if (plan.steps.length > 8) {
      throw new Error(
        `Plan has ${plan.steps.length} steps — exceeds maximum of 8.`,
      );
    }
  } catch (err) {
    const e = err as any;
    // ── DEBUG: full error anatomy ──────────────────────────────────────────
    console.error("[plan:error] message   :", e?.message);
    console.error("[plan:error] name      :", e?.name);
    console.error(
      "[plan:error] status    :",
      e?.status ?? e?.statusCode ?? e?.response?.status,
    );
    console.error("[plan:error] url       :", e?.url ?? e?.response?.url);
    console.error(
      "[plan:error] body      :",
      JSON.stringify(e?.responseBody ?? e?.data ?? e?.response?.data ?? null),
    );
    console.error(
      "[plan:error] cause     :",
      e?.cause?.message ?? e?.cause ?? null,
    );
    console.error("[plan:error] full      :", e);
    // ──────────────────────────────────────────────────────────────────────
    await writeErrorMessage(
      conversationId,
      `Planning failed: ${e?.message ?? String(err)}`,
    );
    throw err;
  }

  // Validate executor allowlist
  console.log("Validating executor allowlist");
  const allowedSlugs = new Set(agent.delegatesTo.map((e) => e.slug));
  const invalidSteps = plan.steps.filter((s) => !allowedSlugs.has(s.agent));

  if (invalidSteps.length > 0) {
    const msg = `Plan references unknown agents: ${invalidSteps.map((s) => s.agent).join(", ")}`;
    await writeErrorMessage(conversationId, msg);
    throw new Error(msg);
  }

  // 6b. Save manager's LLM thread for synthesis (system + conversation + assistant plan)
  console.log("6b. Saving manager's LLM thread for synthesis");
  const managerThread: ModelMessage[] = [
    { role: "user", content: userMessage.content },
  ];

  // 7. Persist ExecutionPlan
  console.log("7. Persisting ExecutionPlan");
  const executionPlan = await prisma.executionPlan.create({
    data: {
      conversationId,
      messageId,
      managerSlug: agentSlug,
      status: "EXECUTING",
      steps: plan.steps,
      currentStepIndex: 0,
      managerThread: managerThread as object[],
      notionPageIds: selectedPageIds,
      notionContext: notionContext || null,
      synthesisPrompt: plan.synthesisPrompt,
      synthesisRequired: plan.synthesisRequired,
    },
  });

  // 8. Enqueue first executor step
  console.log("8. Enqueuing first executor step");
  await enqueueExecutorRun({
    executionPlanId: executionPlan.id,
    stepIndex: 0,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function writeErrorMessage(
  conversationId: string,
  content: string,
): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.assistant,
      content: `⚠️ ${content}`,
      status: MessageStatus.DONE,
    },
  });
}
