import { generateObject } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { enqueueExecutorRun } from "@/lib/queue";
import type { ManagerPlanJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";

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
  const agent = await prisma.agent.findUnique({
    where: { slug: agentSlug },
    include: {
      delegatesTo: { select: { slug: true, name: true, role: true } },
    },
  });

  if (!agent) throw new Error(`Agent not found: ${agentSlug}`);

  // 2. Load conversation history for LLM context
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
    const result = await generateObject({
      model: resolveModel(agent.model),
      system: systemPrompt,
      messages,
      schema: ExecutionPlanSchema,
    });

    plan = result.object;
  } catch (err) {
    await writeErrorMessage(
      conversationId,
      `Planning failed: ${(err as Error).message}`,
    );
    throw err;
  }

  // 4. Validate executor allowlist
  const allowedSlugs = new Set(agent.delegatesTo.map((e) => e.slug));
  const invalidSteps = plan.steps.filter((s) => !allowedSlugs.has(s.agent));

  if (invalidSteps.length > 0) {
    const msg = `Plan references unknown agents: ${invalidSteps.map((s) => s.agent).join(", ")}`;
    await writeErrorMessage(conversationId, msg);
    throw new Error(msg);
  }

  // 5. Save manager's LLM thread for synthesis (system + conversation + assistant plan)
  const managerThread: ModelMessage[] = [
    { role: "user", content: userMessage.content },
  ];

  // 6. Persist ExecutionPlan
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
