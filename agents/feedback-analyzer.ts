/**
 * Feedback Analyzer — Meta-Agent
 *
 * Receives a full execution trace for a run the user marked as bad,
 * identifies which layer failed, and proposes up to 3 targeted fixes.
 *
 * Called from workers/feedback-analyzer.ts after job is enqueued.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveModel } from "@/lib/llm";

// ── Input / Output schemas ──────────────────────────────────────────────────

export const AnalyzerInputSchema = z.object({
  userMessage: z.string(),
  feedbackText: z.string().nullable(),
  routerDecision: z
    .object({
      domain: z.string(),
      mode: z.string(),
    })
    .nullable(),
  managerAgent: z
    .object({
      slug: z.string(),
      systemPrompt: z.string(),
      delegatesTo: z.array(z.string()),
      model: z.string(),
    })
    .nullable(),
  executionPlan: z
    .object({
      steps: z.array(
        z.object({
          agent: z.string(),
          promptTemplate: z.string(),
        }),
      ),
      synthesisPrompt: z.string().optional(),
    })
    .nullable(),
  managerPlanningThread: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
      }),
    )
    .nullable(),
  executorResults: z
    .array(
      z.object({
        agent: z.string(),
        resolvedPrompt: z.string(),
        output: z.string().nullable(),
        status: z.enum(["DONE", "FAILED", "PENDING", "RUNNING"]),
      }),
    )
    .nullable(),
  finalSynthesis: z.string(),
});

export type AnalyzerInput = z.infer<typeof AnalyzerInputSchema>;

// ── Fix variants ────────────────────────────────────────────────────────────

const UpdatePromptFixSchema = z.object({
  type: z.literal("update_prompt"),
  agentSlug: z.string(),
  currentValue: z.string(),
  suggestedValue: z.string(),
  reasoning: z.string(),
  applied: z.boolean().optional(),
});

const UpdateDelegatesToFixSchema = z.object({
  type: z.literal("update_delegatesTo"),
  agentSlug: z.string(),
  currentValue: z.array(z.string()),
  suggestedValue: z.array(z.string()),
  reasoning: z.string(),
  applied: z.boolean().optional(),
});

const UpdateModelFixSchema = z.object({
  type: z.literal("update_model"),
  agentSlug: z.string(),
  currentValue: z.string(),
  suggestedValue: z.string(),
  reasoning: z.string(),
  applied: z.boolean().optional(),
});

const UpdateNotionScopeFixSchema = z.object({
  type: z.literal("update_notionScope"),
  agentSlug: z.string(),
  currentValue: z.unknown(),
  suggestedValue: z.unknown(),
  reasoning: z.string(),
  applied: z.boolean().optional(),
});

export const FixSchema = z.discriminatedUnion("type", [
  UpdatePromptFixSchema,
  UpdateDelegatesToFixSchema,
  UpdateModelFixSchema,
  UpdateNotionScopeFixSchema,
]);

export type Fix = z.infer<typeof FixSchema>;

export const AnalyzerOutputSchema = z.object({
  failedLayer: z.enum(["router", "planning", "executor", "synthesis", "multiple"]),
  summary: z.string(),
  fixes: z.array(FixSchema).max(3),
});

export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

// ── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a diagnostic agent for a multi-agent AI system.

You receive a full execution trace for a run that the user marked as producing a bad result. Your job is to:
1. Identify which layer failed: router (wrong domain/mode selected), planning (wrong agents chosen or bad prompt templates), executor (an agent produced poor output), synthesis (the final assembly was wrong), or multiple.
2. Propose specific, minimal fixes — maximum 3.

## Rules
- Be conservative. Only suggest a fix when you are confident it will help.
- Prefer adding a targeted sentence to a system prompt over rewriting it entirely.
- Every fix must reference a real agentSlug from the trace. Never invent agent slugs.
- For update_delegatesTo fixes: suggestedValue must be the full new array, not a diff.
- If the user provided feedback text, weight it heavily — it is their direct explanation of what went wrong.
- If you cannot identify a specific actionable fix, return an empty fixes array. The summary diagnosis alone has value.
- If trace data is missing or null for some fields, work with what is available. Do not hallucinate missing steps.

## Failure layer definitions
- router: The wrong manager agent was selected for the request domain/mode.
- planning: The manager chose the wrong executor agents, produced a bad sequence, or wrote poor prompt templates.
- executor: One or more executor agents produced incorrect, incomplete, or hallucinated output.
- synthesis: The final synthesis step misrepresented, dropped, or incorrectly combined executor outputs.
- multiple: Two or more distinct layers each contributed meaningfully to the failure.

## Output format
Return a JSON object with:
- failedLayer: one of the five values above
- summary: 2–3 sentences of plain-English diagnosis. Be specific — name the agent slugs involved.
- fixes: array of 0–3 fix objects

Each fix object must have a "type" field which is one of:
  update_prompt | update_delegatesTo | update_model | update_notionScope

All fix objects require: agentSlug, currentValue, suggestedValue, reasoning.`;

// ── Analyzer call ───────────────────────────────────────────────────────────

/**
 * Calls the LLM analyzer and returns a validated AnalyzerOutput.
 * Throws on network error or Zod validation failure (caller handles retries).
 */
export async function runFeedbackAnalyzer(
  input: AnalyzerInput,
): Promise<AnalyzerOutput> {
  const prompt = buildAnalyzerPrompt(input);

  const result = await generateText({
    model: resolveModel("claude-sonnet"),
    system: SYSTEM_PROMPT,
    prompt,
    output: Output.object({ schema: AnalyzerOutputSchema }),
  });

  // Output.object with a Zod schema means the SDK already validated —
  // parse again to get the typed value and strip any extra fields.
  return AnalyzerOutputSchema.parse(result.output);
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildAnalyzerPrompt(input: AnalyzerInput): string {
  const sections: string[] = [];

  sections.push(`## User request\n${input.userMessage}`);

  if (input.feedbackText) {
    sections.push(`## User feedback (what was wrong)\n${input.feedbackText}`);
  }

  if (input.routerDecision) {
    sections.push(
      `## Router decision\nDomain: ${input.routerDecision.domain}\nMode: ${input.routerDecision.mode}`,
    );
  }

  if (input.managerAgent) {
    const { slug, systemPrompt, delegatesTo, model } = input.managerAgent;
    sections.push(
      `## Manager agent\nSlug: ${slug}\nModel: ${model}\nDelegates to: ${delegatesTo.join(", ")}\n\nSystem prompt:\n${systemPrompt}`,
    );
  }

  if (input.executionPlan) {
    const stepsText = input.executionPlan.steps
      .map(
        (s, i) =>
          `  Step ${i}: agent="${s.agent}"\n  Prompt template: ${s.promptTemplate}`,
      )
      .join("\n\n");
    const synthText = input.executionPlan.synthesisPrompt
      ? `\n\nSynthesis prompt:\n${input.executionPlan.synthesisPrompt}`
      : "";
    sections.push(`## Execution plan\n${stepsText}${synthText}`);
  }

  if (input.managerPlanningThread && input.managerPlanningThread.length > 0) {
    const threadText = input.managerPlanningThread
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
    sections.push(`## Manager planning thread\n${threadText}`);
  }

  if (input.executorResults && input.executorResults.length > 0) {
    const resultsText = input.executorResults
      .map(
        (r) =>
          `  Agent: ${r.agent} (${r.status})\n  Prompt: ${r.resolvedPrompt}\n  Output: ${r.output ?? "(none)"}`,
      )
      .join("\n\n");
    sections.push(`## Executor results\n${resultsText}`);
  }

  sections.push(`## Final synthesis (the message the user thumbed down)\n${input.finalSynthesis}`);

  return sections.join("\n\n---\n\n");
}
