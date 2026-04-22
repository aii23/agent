import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import type { ManagerSynthesizeJobData } from "@/lib/queue";
import { MessageRole, MessageStatus } from "@prisma/client";
import type { ModelMessage } from "ai";

// ── Synthesis system prompt (shared across all managers) ──────────────────
//
// Why a shared prompt and not the manager's persona?
//
// Manager system prompts (CEO/CPO/CMO/...) are written for the *planning*
// job: they list executors, give few-shot plan examples, describe how to
// route work, etc. When the same prompt is used unmodified at synthesis
// time, those planning-oriented sections leak into the output — the model
// roleplays simulated downstream agents ("Now sending to cpo-reviewer..."),
// includes "Step N of M" headers, narrates the pipeline, and so on.
//
// Splitting the two jobs:
//   - Planner-side: keeps the rich persona prompt (read by plan.ts to write
//     a good plan and a tailored synthesisPrompt for the turn).
//   - Synthesizer-side: this single prompt. Treats the planner-authored
//     synthesisPrompt as a contract and produces the user-facing message.
//
// The planner-authored synthesisPrompt carries everything turn-specific
// (tone, format, length, what to lead with, what to weigh). This prompt
// is purely the discipline + framing the model needs to honour it cleanly.
const SYNTHESIS_SYSTEM_PROMPT = `You are the final delivery stage of a multi-agent system. You will receive:
1. The original user request (in the conversation history).
2. A specific instruction (the synthesisPrompt) authored by the manager that planned this turn — this is your brief.
3. The concatenated outputs of the executor agents that ran for this turn, embedded inside that brief.

Your job is to produce the message the user sees. Treat the synthesisPrompt as a contract: follow its format, tone, length, and structural requirements exactly.

Output discipline:
- Return ONLY the user-facing message. The user reads your output verbatim.
- No execution metadata: no "Plan:", no "Step N of M", no agent slug headers, no "Now sending to ...", no "Routing to ...".
- Do not roleplay or simulate any other agent's response. The pipeline is OVER. There are no follow-up steps after this one.
- Do not narrate what you are about to do or just did. Just deliver the result.
- If the synthesisPrompt instructs you to "route", "send", "have X review", or "then do Y" — ignore it. Produce the final artifact now.
- If a reviewer/researcher informed your answer, fold it in silently. Do not quote a reviewer dialog.

Quality calibration (apply unless the synthesisPrompt overrides):
- Lead with the answer, recommendation, or artifact. Reasoning and supporting findings come after.
- Surface trade-offs honestly. Do not hide alternatives the user should weigh.
- State assumptions explicitly when relevant.
- Be specific. Avoid generic framing like "Here is a comprehensive overview of...".`;

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
 *
 * Uses the shared SYNTHESIS_SYSTEM_PROMPT — NOT the manager's persona — so
 * planner-side template language ("→ cpo-reviewer only if it'll ship", etc.)
 * doesn't leak into the synthesis output as simulated agent transcripts.
 *
 * `agent.model` is still used to pick the model (Sonnet for managers).
 * Per-manager voice / tone / structure for this specific turn comes through
 * the planner-authored synthesisPrompt, which already encodes it.
 */
async function runFullSynthesis(
  plan: {
    managerThread: unknown;
    synthesisPrompt: string | null;
    executionSteps: CompletedStep[];
  },
  agent: { model: string },
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
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages,
  });

  return result.text;
}
