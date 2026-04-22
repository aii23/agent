import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import type { ManagerSynthesizeJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";

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

  let finalResponse: string;

  try {
    if (plan.synthesisRequired === false && plan.executionSteps.length > 0) {
      // ── Short-circuit path ──────────────────────────────────────────────
      // The planner declared the last executor's output to be the deliverable.
      // Run a tiny Haiku formatter pass to strip artifacts (executor headers,
      // assumption blocks, redundant preamble) instead of paying for a full
      // Sonnet synthesis. ~10× cheaper, ~5× faster, identical user-visible
      // result for "polish this" / "draft that" style requests.
      finalResponse = await runFormatterPass(plan.executionSteps);
    } else {
      // ── Full synthesis path ─────────────────────────────────────────────
      finalResponse = await runFullSynthesis(plan, agent);
    }
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

// ── Helpers ────────────────────────────────────────────────────────────────

type CompletedStep = { agentSlug: string; output: string | null };

/**
 * Cheap final-formatter pass.
 *
 * Used when the planner sets synthesisRequired=false — i.e. the last executor
 * already produced the deliverable. We run a small Haiku call (not Sonnet) that
 * strips executor artifacts (`Assumptions:` blocks, "Here is your tweet:"
 * preambles, leftover step headers) without re-writing the content.
 *
 * Cost: ~$0.003 vs ~$0.04 for full Sonnet synthesis.
 */
async function runFormatterPass(steps: CompletedStep[]): Promise<string> {
  const lastStep = steps[steps.length - 1];
  const lastOutput = (lastStep.output ?? "").trim();

  if (!lastOutput) {
    throw new Error("Last executor produced empty output");
  }

  // Cheap heuristic: if the output is already clean (no obvious executor
  // artifacts), return it verbatim and skip the formatter call entirely.
  if (!hasExecutorArtifacts(lastOutput)) {
    return lastOutput;
  }

  const result = await generateText({
    model: resolveModel("claude-haiku"),
    system:
      "You are a final-pass formatter. You receive an executor agent's output and return it ready to ship to the end user. Strip leftover preambles ('Here is...', 'I've drafted...'), executor self-commentary, 'Assumptions:' blocks at the end, and step headers. Keep the substance verbatim — do not rewrite, shorten, or reinterpret. Return only the cleaned content.",
    prompt: lastOutput,
    maxOutputTokens: 1500,
  });

  return result.text.trim();
}

/**
 * Detects whether an executor output contains formatting artifacts that the
 * formatter pass should clean up. Conservative — only flags clear signals.
 */
function hasExecutorArtifacts(text: string): boolean {
  const head = text.slice(0, 200);
  const tail = text.slice(-400);
  return (
    /^(here['']s|here is|i['']ve|i have|sure[,.]|certainly[,.])/i.test(head) ||
    /\n\s*Assumptions?:\s*\n/i.test(tail) ||
    /^##?\s*(variant|step)\s*[a-z0-9]/im.test(head)
  );
}

/**
 * Full Sonnet synthesis path. Used when the planner needs the manager to
 * combine multiple executor outputs, add judgement, or frame a recommendation.
 */
async function runFullSynthesis(
  plan: {
    managerThread: unknown;
    synthesisPrompt: string | null;
    executionSteps: CompletedStep[];
  },
  agent: { model: string; systemPrompt: string },
): Promise<string> {
  const managerThread = (plan.managerThread as ModelMessage[]) ?? [];

  const executorResultsText = plan.executionSteps
    .map((step, i) => `## Step ${i + 1} — ${step.agentSlug}\n\n${step.output}`)
    .join("\n\n---\n\n");

  const synthesisContent = plan.synthesisPrompt
    ? plan.synthesisPrompt.replace("{{executorResults}}", executorResultsText)
    : `Here are the results from the executor agents:\n\n${executorResultsText}\n\nPlease synthesize these results into a final response for the user.`;

  const messages: ModelMessage[] = [
    ...managerThread,
    { role: "user", content: synthesisContent },
  ];

  const result = await generateText({
    model: resolveModel(agent.model),
    system: agent.systemPrompt,
    messages,
  });

  return result.text;
}
