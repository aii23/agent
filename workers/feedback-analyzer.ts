/**
 * Feedback Analyzer Worker
 *
 * Handles "feedback.analyze" jobs from the agent queue.
 * Runs the meta-agent LLM call, validates output, and persists
 * the result back to MessageFeedback.analysis.
 */

import { prisma } from "@/lib/prisma";
import { runFeedbackAnalyzer, AnalyzerInputSchema } from "@/agents/feedback-analyzer";
import type { FeedbackAnalyzeJobData } from "@/lib/queue";

const MAX_ATTEMPTS = 2;

export async function handleFeedbackAnalyze(
  data: FeedbackAnalyzeJobData,
): Promise<void> {
  const { feedbackId, analyzerInput } = data;

  // Mark as analyzing
  await prisma.messageFeedback.update({
    where: { id: feedbackId },
    data: { status: "analyzing" },
  });

  // Parse and validate the input payload (stored as unknown in the queue)
  const parsedInput = AnalyzerInputSchema.parse(analyzerInput);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[feedback-analyzer] feedbackId=${feedbackId} attempt=${attempt}`,
      );

      const output = await runFeedbackAnalyzer(parsedInput);

      await prisma.messageFeedback.update({
        where: { id: feedbackId },
        data: {
          status: "completed",
          analysis: output as object,
        },
      });

      console.log(
        `[feedback-analyzer] feedbackId=${feedbackId} completed — layer=${output.failedLayer} fixes=${output.fixes.length}`,
      );
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        `[feedback-analyzer] feedbackId=${feedbackId} attempt=${attempt} failed:`,
        (err as Error).message,
      );
    }
  }

  // Both attempts failed — store partial result if we have a summary, otherwise fail cleanly
  console.error(
    `[feedback-analyzer] feedbackId=${feedbackId} all attempts failed`,
    lastError,
  );

  await prisma.messageFeedback.update({
    where: { id: feedbackId },
    data: { status: "failed" },
  });

  throw lastError;
}
