import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { enqueueExecutorRun, enqueueManagerSynthesize } from "@/lib/queue";
import type { ExecutorRunJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";

// ── Types ──────────────────────────────────────────────────────────────────

interface PlanStep {
  agent: string;
  promptTemplate: string;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleExecutorRun(
  data: ExecutorRunJobData,
): Promise<void> {
  const { executionPlanId, stepIndex } = data;

  // 1. Load execution plan + all completed steps (for output chaining)
  const plan = await prisma.executionPlan.findUnique({
    where: { id: executionPlanId },
    include: {
      executionSteps: {
        where: { status: "DONE" },
        orderBy: { stepIndex: "asc" },
      },
    },
  });

  if (!plan) throw new Error(`ExecutionPlan not found: ${executionPlanId}`);
  if (plan.status === "FAILED") return; // abort if plan already failed

  const steps = plan.steps as unknown as PlanStep[];
  const currentStep = steps[stepIndex];
  if (!currentStep)
    throw new Error(`Step ${stepIndex} not found in plan ${executionPlanId}`);

  // 2. Load executor agent
  const agent = await prisma.agent.findUnique({
    where: { slug: currentStep.agent },
  });

  if (!agent) throw new Error(`Executor agent not found: ${currentStep.agent}`);

  // 3. Load original user message for {{userRequest}} substitution
  const triggerMessage = await prisma.message.findUnique({
    where: { id: plan.messageId },
  });

  if (!triggerMessage)
    throw new Error(`Trigger message not found: ${plan.messageId}`);

  // 4. Resolve template variables
  const resolvedPrompt = resolveTemplate(
    currentStep.promptTemplate,
    triggerMessage.content,
    plan.executionSteps,
    plan.notionContext ?? "",
  );

  // 5. Persist the step record as RUNNING (upsert handles BullMQ retries cleanly)
  const executionStep = await prisma.executionStep.upsert({
    where: {
      executionPlanId_stepIndex: { executionPlanId, stepIndex },
    },
    create: {
      executionPlanId,
      stepIndex,
      agentSlug: currentStep.agent,
      resolvedPrompt,
      status: "RUNNING",
    },
    update: {
      resolvedPrompt,
      status: "RUNNING",
      output: null,
      completedAt: null,
    },
  });

  let output: string;

  try {
    // 6. Call executor LLM
    const result = await generateText({
      model: resolveModel(agent.model),
      system: agent.systemPrompt,
      prompt: resolvedPrompt,
    });

    output = result.text;
  } catch (err) {
    await prisma.executionStep.update({
      where: { id: executionStep.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    await failPlan(
      executionPlanId,
      plan.conversationId,
      `Step ${stepIndex} (${currentStep.agent}) failed: ${(err as Error).message}`,
    );
    throw err;
  }

  // 7. Store step result
  await prisma.executionStep.update({
    where: { id: executionStep.id },
    data: {
      output,
      status: "DONE",
      completedAt: new Date(),
    },
  });

  // 8. Update currentStepIndex on the plan
  await prisma.executionPlan.update({
    where: { id: executionPlanId },
    data: { currentStepIndex: stepIndex + 1 },
  });

  // 9. Enqueue next step or synthesize
  const isLastStep = stepIndex + 1 >= steps.length;

  if (isLastStep) {
    await prisma.executionPlan.update({
      where: { id: executionPlanId },
      data: { status: "SYNTHESIZING" },
    });
    await enqueueManagerSynthesize({ executionPlanId });
  } else {
    await enqueueExecutorRun({ executionPlanId, stepIndex: stepIndex + 1 });
  }
}

// ── Template resolver ──────────────────────────────────────────────────────

/**
 * Substitutes template variables in a step's promptTemplate:
 *   {{userRequest}}      → the original user message content
 *   {{notionContext}}    → Notion workspace context fetched during planning
 *   {{steps[N].output}}  → the output of completed step N (0-indexed)
 */
export function resolveTemplate(
  template: string,
  userRequest: string,
  completedSteps: Array<{ stepIndex: number; output: string | null }>,
  notionContext: string = "",
): string {
  let resolved = template.replace(/\{\{userRequest\}\}/g, userRequest);

  resolved = resolved.replace(/\{\{notionContext\}\}/g, notionContext);

  resolved = resolved.replace(
    /\{\{steps\[(\d+)\]\.output\}\}/g,
    (match, indexStr) => {
      const index = parseInt(indexStr, 10);
      const step = completedSteps.find((s) => s.stepIndex === index);
      if (!step?.output) {
        throw new Error(
          `Template references step[${index}].output but it is not available`,
        );
      }
      return step.output;
    },
  );

  return resolved;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function failPlan(
  executionPlanId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  await prisma.executionPlan.update({
    where: { id: executionPlanId },
    data: { status: "FAILED" },
  });
  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.assistant,
      content: `⚠️ ${reason}`,
      status: MessageStatus.DONE,
    },
  });
}
