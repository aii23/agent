import { generateText, Output } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { enqueueExecutorRun } from "@/lib/queue";
import type { ManagerPlanJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";

import { config } from "dotenv";
config({ path: ".env.local" });

// ── Plan step schema ───────────────────────────────────────────────────────

const PlanStepSchema = z.object({
  agent: z.string(),
  promptTemplate: z.string(),
});

const ExecutionPlanSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(8),
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

  const systemPrompt = `${agent.systemPrompt}

You have access to the following executor agents:
${availableExecutors}

When responding, produce an execution plan as a structured list of steps.
Each step must reference one of the executor agents listed above.
Use {{userRequest}} in promptTemplate to refer to the user's request.
Use {{steps[N].output}} to reference the output of a previous step (0-indexed).
Maximum 8 steps.`;

  const messages: ModelMessage[] = [
    ...priorMessages,
    { role: "user", content: userMessage.content },
  ];

  let plan: { steps: PlanStep[] };

  try {
    // 3. Call LLM to generate execution plan
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
    // ──────────────────────────────────────────────────────────────────────

    console.log("3. Calling LLM to generate execution plan");
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

  // 4. Validate executor allowlist
  console.log("4. Validating executor allowlist");
  const allowedSlugs = new Set(agent.delegatesTo.map((e) => e.slug));
  const invalidSteps = plan.steps.filter((s) => !allowedSlugs.has(s.agent));

  if (invalidSteps.length > 0) {
    const msg = `Plan references unknown agents: ${invalidSteps.map((s) => s.agent).join(", ")}`;
    await writeErrorMessage(conversationId, msg);
    throw new Error(msg);
  }

  // 5. Save manager's LLM thread for synthesis (system + conversation + assistant plan)
  console.log("5. Saving manager's LLM thread for synthesis");
  const managerThread: ModelMessage[] = [
    { role: "user", content: userMessage.content },
  ];

  // 6. Persist ExecutionPlan
  console.log("6. Persisting ExecutionPlan");
  const executionPlan = await prisma.executionPlan.create({
    data: {
      conversationId,
      messageId,
      managerSlug: agentSlug,
      status: "EXECUTING",
      steps: plan.steps,
      currentStepIndex: 0,
      managerThread: managerThread as object[],
    },
  });

  // 7. Enqueue first executor step
  console.log("7. Enqueuing first executor step");
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
