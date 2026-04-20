import { z } from "zod";
import { router, protectedProcedure, TRPCError } from "../trpc";

export const executionsRouter = router({
  // GET /trpc/executions.list
  list: protectedProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.prisma.executionPlan.findMany({
        select: {
          id: true,
          managerSlug: true,
          status: true,
          currentStepIndex: true,
          createdAt: true,
          updatedAt: true,
          conversation: {
            select: { id: true, title: true },
          },
          executionSteps: {
            select: { id: true, status: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      const hasMore = items.length > input.limit;
      const plans = hasMore ? items.slice(0, input.limit) : items;

      return {
        plans,
        nextCursor: hasMore ? plans[plans.length - 1]?.id : undefined,
      };
    }),

  // GET /trpc/executions.byId?input={"id":"..."}
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const plan = await ctx.prisma.executionPlan.findUnique({
        where: { id: input.id },
        include: {
          conversation: {
            select: { id: true, title: true },
          },
          executionSteps: {
            orderBy: { stepIndex: "asc" },
          },
        },
      });

      if (!plan)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Execution plan not found",
        });

      return plan;
    }),
});
