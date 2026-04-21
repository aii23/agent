import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import type { ManagerSynthesizeJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";
import { cachedSystem } from "@/lib/llm-cache";

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleManagerSynthesize(
  data: ManagerSynthesizeJobData,
): Promise<void> {
  const { executionPlanId } = data;

  // 1. Load plan + manager agent + all completed steps
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
  if (plan.status === "FAILED") return;

  const agent = await prisma.agent.findUnique({
    where: { slug: plan.managerSlug },
  });

  if (!agent) throw new Error(`Manager agent not found: ${plan.managerSlug}`);

  // 2. Load the saved manager thread from the planning phase
  const managerThread = (plan.managerThread as ModelMessage[]) ?? [];

  // 3. Build synthesis message: append executor results to the thread
  const executorResultsText = plan.executionSteps
    .map((step, i) => `## Step ${i + 1} — ${step.agentSlug}\n\n${step.output}`)
    .join("\n\n---\n\n");

  // Use the planner-authored prompt when available; fall back to a generic
  // instruction only for plans created before this field existed.
  const synthesisContent = plan.synthesisPrompt
    ? plan.synthesisPrompt.replace("{{executorResults}}", executorResultsText)
    : `Here are the results from the executor agents:\n\n${executorResultsText}\n\nPlease synthesize these results into a final response for the user.`;

  const synthesisUserMessage: ModelMessage = {
    role: "user",
    content: synthesisContent,
  };

  const messages: ModelMessage[] = [...managerThread, synthesisUserMessage];

  let finalResponse: string;

  try {
    // 4. Call manager LLM with full reconstructed thread
    const result = await generateText({
      model: resolveModel(agent.model),
      // Manager system prompt is identical between plan and synthesis calls —
      // caching gives a near-free read on the synthesis turn.
      system: cachedSystem(agent.systemPrompt),
      messages,
    });

    finalResponse = result.text;
  } catch (err) {
    await prisma.executionPlan.update({
      where: { id: executionPlanId },
      data: { status: "FAILED" },
    });
    await prisma.message.create({
      data: {
        conversationId: plan.conversationId,
        role: MessageRole.assistant,
        content: `⚠️ Synthesis failed: ${(err as Error).message}`,
        status: MessageStatus.DONE,
      },
    });
    throw err;
  }

  // 5. Write final assistant message to conversation
  await prisma.message.create({
    data: {
      conversationId: plan.conversationId,
      role: MessageRole.assistant,
      content: finalResponse,
      status: MessageStatus.DONE,
    },
  });

  // 6. Mark plan as done
  await prisma.executionPlan.update({
    where: { id: executionPlanId },
    data: { status: "DONE" },
  });
}
