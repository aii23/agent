import { z } from "zod";
import { router, protectedProcedure, TRPCError } from "../trpc";
import { enqueueFeedbackAnalyze } from "@/lib/queue";
import type { AnalyzerInput } from "@/agents/feedback-analyzer";
import type { AnalyzerOutput } from "@/agents/feedback-analyzer";
import type { PrismaClient } from "@prisma/client";

// ── Types ──────────────────────────────────────────────────────────────────

interface PlanStep {
  agent: string;
  promptTemplate: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Assembles the full AnalyzerInput from the DB in a single pass.
 * Called during submit so the worker receives a complete payload with no DB reads.
 */
async function assembleAnalyzerInput(
  prisma: PrismaClient,
  messageId: string,
  finalSynthesis: string,
  feedbackText: string | null,
): Promise<AnalyzerInput> {
  // 1. Load the thumbed-down assistant message and its conversation
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      createdAt: true,
      conversation: {
        select: {
          id: true,
          agentId: true,
          agent: { select: { slug: true } },
          messages: {
            orderBy: { createdAt: "asc" },
            select: { id: true, role: true, content: true, createdAt: true },
          },
        },
      },
    },
  });

  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });

  // 2. Find the user message immediately before this assistant message
  const allMessages = message.conversation.messages;
  const msgIndex = allMessages.findIndex((m) => m.id === messageId);
  const priorMessages = msgIndex > 0 ? allMessages.slice(0, msgIndex) : [];
  const triggerUserMsg = [...priorMessages].reverse().find((m) => m.role === "user");

  const userMessageContent = triggerUserMsg?.content ?? "(unknown)";

  // 3. Find the ExecutionPlan associated with the triggering user message
  const executionPlan = triggerUserMsg
    ? await prisma.executionPlan.findFirst({
        where: {
          conversationId: message.conversationId,
          messageId: triggerUserMsg.id,
        },
        include: {
          executionSteps: { orderBy: { stepIndex: "asc" } },
        },
      })
    : null;

  // 4. Load manager agent if we have one
  const managerSlug = executionPlan?.managerSlug ?? message.conversation.agent?.slug ?? null;
  const managerAgent = managerSlug
    ? await prisma.agent.findUnique({
        where: { slug: managerSlug },
        include: { delegatesTo: { select: { slug: true } } },
      })
    : null;

  // 5. Assemble
  return {
    userMessage: userMessageContent,
    feedbackText,
    routerDecision: managerSlug
      ? { domain: managerSlug, mode: "orchestrated" }
      : null,
    managerAgent: managerAgent
      ? {
          slug: managerAgent.slug,
          systemPrompt: managerAgent.systemPrompt,
          delegatesTo: managerAgent.delegatesTo.map((d) => d.slug),
          model: managerAgent.model,
        }
      : null,
    executionPlan: executionPlan
      ? {
          steps: (executionPlan.steps as unknown as PlanStep[]) ?? [],
          synthesisPrompt: executionPlan.synthesisPrompt ?? undefined,
        }
      : null,
    managerPlanningThread: executionPlan?.managerThread
      ? (executionPlan.managerThread as Array<{ role: string; content: string }>)
      : null,
    executorResults: executionPlan?.executionSteps?.map((s) => ({
      agent: s.agentSlug,
      resolvedPrompt: s.resolvedPrompt,
      output: s.output ?? null,
      status: s.status as "DONE" | "FAILED" | "PENDING" | "RUNNING",
    })) ?? null,
    finalSynthesis,
  };
}

// ── Router ─────────────────────────────────────────────────────────────────

export const feedbackRouter = router({

  // POST /trpc/feedback.submit
  submit: protectedProcedure
    .input(
      z.object({
        messageId: z.string(),
        feedbackText: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Idempotency: return existing feedback if already submitted for this message
      const existing = await ctx.prisma.messageFeedback.findUnique({
        where: { messageId: input.messageId },
        select: { id: true },
      });
      if (existing) return { feedbackId: existing.id };

      // Load the message to validate ownership and get content
      const message = await ctx.prisma.message.findUnique({
        where: { id: input.messageId },
        select: {
          id: true,
          content: true,
          role: true,
          conversation: { select: { userId: true } },
        },
      });

      if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
      if (message.conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      if (message.role !== "assistant") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Can only submit feedback on assistant messages" });
      }

      // Assemble trace context before creating the DB row
      const analyzerInput = await assembleAnalyzerInput(
        ctx.prisma as unknown as PrismaClient,
        input.messageId,
        message.content,
        input.feedbackText ?? null,
      );

      // Create feedback row
      const feedback = await ctx.prisma.messageFeedback.create({
        data: {
          messageId: input.messageId,
          userId: ctx.user.id,
          feedbackText: input.feedbackText ?? null,
          status: "pending",
        },
        select: { id: true },
      });

      // Enqueue analysis job (fire-and-forget — failure here is non-fatal)
      try {
        await enqueueFeedbackAnalyze({
          feedbackId: feedback.id,
          analyzerInput,
        });
      } catch (err) {
        console.error("[feedback.submit] failed to enqueue analysis job:", err);
        // Don't throw — feedback row is created; worker will stay in pending state
      }

      return { feedbackId: feedback.id };
    }),

  // GET /trpc/feedback.get
  get: protectedProcedure
    .input(z.object({ feedbackId: z.string() }))
    .query(async ({ input, ctx }) => {
      const feedback = await ctx.prisma.messageFeedback.findUnique({
        where: { id: input.feedbackId },
        select: {
          id: true,
          status: true,
          analysis: true,
          message: { select: { conversation: { select: { userId: true } } } },
        },
      });

      if (!feedback) throw new TRPCError({ code: "NOT_FOUND", message: "Feedback not found" });
      if (feedback.message.conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return {
        status: feedback.status,
        analysis: feedback.analysis as AnalyzerOutput | null,
      };
    }),

  // POST /trpc/feedback.applyFix
  applyFix: protectedProcedure
    .input(
      z.object({
        feedbackId: z.string(),
        fixIndex: z.number().int().min(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const feedback = await ctx.prisma.messageFeedback.findUnique({
        where: { id: input.feedbackId },
        select: {
          id: true,
          analysis: true,
          message: { select: { conversation: { select: { userId: true } } } },
        },
      });

      if (!feedback) throw new TRPCError({ code: "NOT_FOUND", message: "Feedback not found" });
      if (feedback.message.conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      if (!feedback.analysis) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Analysis not ready" });
      }

      const analysis = feedback.analysis as AnalyzerOutput;
      const fix = analysis.fixes[input.fixIndex];

      if (!fix) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Fix at index ${input.fixIndex} not found` });
      }
      if (fix.applied) {
        return { applied: true }; // idempotent
      }

      // Apply the fix to the agents table
      const agent = await ctx.prisma.agent.findUnique({
        where: { slug: fix.agentSlug },
        include: { delegatesTo: { select: { id: true, slug: true } } },
      });

      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent "${fix.agentSlug}" not found — cannot apply fix`,
        });
      }

      switch (fix.type) {
        case "update_prompt":
          await ctx.prisma.agent.update({
            where: { id: agent.id },
            data: { systemPrompt: fix.suggestedValue },
          });
          break;

        case "update_model":
          await ctx.prisma.agent.update({
            where: { id: agent.id },
            data: { model: fix.suggestedValue },
          });
          break;

        case "update_notionScope":
          await ctx.prisma.agent.update({
            where: { id: agent.id },
            data: { notionScope: fix.suggestedValue as object },
          });
          break;

        case "update_delegatesTo": {
          // Resolve suggested slugs to IDs
          const targetAgents = await ctx.prisma.agent.findMany({
            where: { slug: { in: fix.suggestedValue } },
            select: { id: true, slug: true },
          });

          const missing = fix.suggestedValue.filter(
            (slug) => !targetAgents.find((a) => a.slug === slug),
          );
          if (missing.length > 0) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Agents not found for delegatesTo fix: ${missing.join(", ")}`,
            });
          }

          await ctx.prisma.agent.update({
            where: { id: agent.id },
            data: { delegatesTo: { set: targetAgents.map((a) => ({ id: a.id })) } },
          });
          break;
        }
      }

      // Mark fix as applied in the JSON
      const updatedFixes = analysis.fixes.map((f, i) =>
        i === input.fixIndex ? { ...f, applied: true } : f,
      );
      const updatedAnalysis: AnalyzerOutput = { ...analysis, fixes: updatedFixes };

      await ctx.prisma.messageFeedback.update({
        where: { id: input.feedbackId },
        data: { analysis: updatedAnalysis as object },
      });

      return { applied: true };
    }),
});
