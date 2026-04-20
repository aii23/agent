import { z } from 'zod'
import { AgentType } from '@prisma/client'
import { router, protectedProcedure, TRPCError } from '../trpc'

function generateSlug(agentType: AgentType): string {
  const prefix = agentType === AgentType.MANAGER ? 'manager' : 'executor'
  return `${prefix}-${Date.now()}`
}

const agentDelegateSelect = {
  id: true,
  slug: true,
  name: true,
  role: true,
  agentType: true,
} as const

const agentWithDelegations = {
  delegatesTo: { select: agentDelegateSelect },
  delegatedBy: { select: { id: true, slug: true, name: true } },
} as const

export const agentsRouter = router({
  // POST /trpc/agents.create
  create: protectedProcedure
    .input(
      z.object({
        agentType: z.enum(['MANAGER', 'EXECUTOR']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const agentType = input.agentType as AgentType
      const slug = generateSlug(agentType)
      const label = agentType === AgentType.MANAGER ? 'Manager' : 'Executor'
      return ctx.prisma.agent.create({
        data: {
          slug,
          name: `New ${label}`,
          role: 'Define this agent role',
          systemPrompt: '',
          agentType,
        },
        include: agentWithDelegations,
      })
    }),

  // GET /trpc/agents.list
  list: protectedProcedure.query(({ ctx }) =>
    ctx.prisma.agent.findMany({
      include: agentWithDelegations,
      orderBy: [{ agentType: 'asc' }, { name: 'asc' }],
    })
  ),

  // GET /trpc/agents.byId?input={"id":"..."}
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findUnique({
        where: { id: input.id },
        include: agentWithDelegations,
      })
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' })
      return agent
    }),

  // PATCH /trpc/agents.update
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        model: z.string().optional(),
        maxSteps: z.number().int().min(1).max(100).optional(),
        notionScope: z.unknown().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, notionScope, ...rest } = input
      return ctx.prisma.agent.update({
        where: { id },
        data: {
          ...rest,
          ...(notionScope !== undefined && { notionScope: notionScope as object }),
        },
        include: agentWithDelegations,
      })
    }),

  // PUT /trpc/agents.setDelegates
  setDelegates: protectedProcedure
    .input(
      z.object({
        managerId: z.string(),
        executorIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const manager = await ctx.prisma.agent.findUnique({
        where: { id: input.managerId },
        select: { agentType: true },
      })
      if (!manager) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' })
      if (manager.agentType !== AgentType.MANAGER) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only MANAGER agents can have delegates',
        })
      }

      if (input.executorIds.length > 0) {
        const executors = await ctx.prisma.agent.findMany({
          where: { id: { in: input.executorIds } },
          select: { id: true, agentType: true },
        })
        if (executors.length !== input.executorIds.length) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'One or more executor IDs not found' })
        }
        const nonExecutors = executors.filter((a) => a.agentType !== AgentType.EXECUTOR)
        if (nonExecutors.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'All delegate IDs must refer to EXECUTOR agents',
          })
        }
      }

      return ctx.prisma.agent.update({
        where: { id: input.managerId },
        data: { delegatesTo: { set: input.executorIds.map((id) => ({ id })) } },
        include: { delegatesTo: { select: agentDelegateSelect } },
      })
    }),
})
