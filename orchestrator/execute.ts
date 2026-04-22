import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { TOOL_EXECUTORS, isToolAgent } from "@/lib/tools/registry";
import { enqueueExecutorRun, enqueueManagerSynthesize } from "@/lib/queue";
import type { ExecutorRunJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import { CACHE_BREAKPOINT } from "@/lib/llm-cache";

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

  // Detect whether this step opts into the workspace context BEFORE
  // substitution. If yes, we put the context in a cached system block and
  // strip it from the prompt body — same content, paid once, cacheable
  // across every executor in the plan that references {{notionContext}}.
  const usesNotionContext =
    currentStep.promptTemplate.includes("{{notionContext}}") &&
    !!plan.notionContext;

  // 4. Resolve template variables. When usesNotionContext is true we pass
  // an empty string for notion so the template marker is removed; the actual
  // context rides in via a cached system message instead.
  const resolvedPrompt = resolveTemplate(
    currentStep.promptTemplate,
    triggerMessage.content,
    plan.executionSteps,
    usesNotionContext ? "" : plan.notionContext ?? "",
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
    if (isToolAgent(currentStep.agent)) {
      // 6a. Tool agent: call the server-side function directly, no LLM
      console.log(`[execute] tool dispatch — agent="${currentStep.agent}"`);
      output = await TOOL_EXECUTORS[currentStep.agent](resolvedPrompt);
    } else {
      // 6b. LLM agent: call the model.
      //
      // When the planner opted this step into workspace context, we put it
      // FIRST as a cached system block. Any subsequent executor in the same
      // plan (or another plan within the cache TTL) that uses the same
      // context hits the cache instead of paying full input cost on the
      // ~1.5K-token block. The executor's own persona goes in a second
      // system block (no breakpoint — short prompts won't cache anyway).
      const messages: ModelMessage[] = [];

      if (usesNotionContext && plan.notionContext) {
        messages.push({
          role: "system",
          content: `<workspace_context>\n${plan.notionContext}\n</workspace_context>`,
          providerOptions: CACHE_BREAKPOINT,
        });
      }

      messages.push(
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: resolvedPrompt },
      );

      const result = await generateText({
        model: resolveModel(agent.model),
        messages,
      });
      output = result.text;
    }
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
