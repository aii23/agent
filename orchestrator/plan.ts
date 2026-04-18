import { generateText, Output } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { enqueueExecutorRun } from "@/lib/queue";
import type { ManagerPlanJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";
import { getNotionIndex, formatNotionIndex } from "@/lib/notion-index";
import { buildNotionContext } from "@/orchestrator/context";

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

  // Build prior messages as context (excluding the triggering message)
  const priorMessages: ModelMessage[] = conversation.messages
    .filter((m) => m.id !== messageId)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const availableExecutors = agent.delegatesTo
    .map((e) => `- ${e.slug}: ${e.role}`)
    .join("\n");

  // ── Phase A: Build Notion context ─────────────────────────────────────────
  // Step A1 — Load the full workspace catalog (lightweight: id + path + summary).
  //           No raw page content fetched yet, no LLM call.
  console.log("3. Loading Notion workspace catalog");
  const pageIndex = await getNotionIndex();
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

  const contextSection = notionContext
    ? `\n\nRelevant context from the Notion workspace:\n${notionContext}\n`
    : "";

  const systemPrompt = `${agent.systemPrompt}

You have access to the following executor agents:
${availableExecutors}
${contextSection}
When responding, produce an execution plan as a structured list of steps.
Each step must reference one of the executor agents listed above.
Use {{userRequest}} in promptTemplate to refer to the user's request.
Use {{notionContext}} in promptTemplate to inject the workspace context into an executor prompt.
Use {{steps[N].output}} to reference the output of a previous step (0-indexed).
Maximum 8 steps.`;

  const messages: ModelMessage[] = [
    ...priorMessages,
    { role: "user", content: userMessage.content },
  ];

  let plan: { steps: PlanStep[] };

  try {
    // 6. Call LLM to generate execution plan
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
    console.log("[plan:debug] systemPrompt len   :", systemPrompt.length);
    console.log("[plan:debug] notionContext len  :", notionContext.length);
    // ──────────────────────────────────────────────────────────────────────

    console.log("6. Calling LLM to generate execution plan");
    const result = await generateText({
      model: resolvedModel,
      system: systemPrompt,
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
