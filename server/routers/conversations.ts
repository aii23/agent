import { z } from 'zod'
import { MessageRole, MessageStatus } from '@prisma/client'
import { router, protectedProcedure, TRPCError } from '../trpc'
import { enqueueAgentRun } from '@/lib/queue'

const messageSelect = {
  id: true,
  conversationId: true,
  role: true,
  content: true,
  status: true,
  createdAt: true,
} as const

const conversationSelect = {
  id: true,
  userId: true,
  agentId: true,
  title: true,
  createdAt: true,
} as const

export const conversationsRouter = router({
  // POST /trpc/conversations.create
  create: protectedProcedure
    .input(
      z.object({
        agentId: z.string().optional(),
        title: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.agentId) {
        const agent = await ctx.prisma.agent.findUnique({ where: { id: input.agentId } })
        if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' })
      }

      return ctx.prisma.conversation.create({
        data: {
          userId: ctx.user.id,
          agentId: input.agentId,
          title: input.title,
        },
        select: conversationSelect,
      })
    }),

  // GET /trpc/conversations.list
  list: protectedProcedure.query(({ ctx }) =>
    ctx.prisma.conversation.findMany({
      where: { userId: ctx.user.id },
      select: {
        ...conversationSelect,
        agent: { select: { id: true, name: true, slug: true } },
        messages: {
          select: messageSelect,
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  ),

  // GET /trpc/conversations.byId?input={"id":"..."}
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.id },
        select: {
          ...conversationSelect,
          messages: {
            select: messageSelect,
            orderBy: { createdAt: 'asc' },
          },
          agent: {
            select: { id: true, slug: true, name: true, role: true },
          },
        },
      })

      if (!conversation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found' })
      if (conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      return conversation
    }),

  // PATCH /trpc/conversations.updateTitle
  updateTitle: protectedProcedure
    .input(z.object({ id: z.string(), title: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.id },
        select: { userId: true },
      })

      if (!conversation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found' })
      if (conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      return ctx.prisma.conversation.update({
        where: { id: input.id },
        data: { title: input.title },
        select: conversationSelect,
      })
    }),

  // DELETE /trpc/conversations.delete
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.id },
        select: { userId: true },
      })

      if (!conversation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found' })
      if (conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      await ctx.prisma.conversation.delete({ where: { id: input.id } })
      return { id: input.id }
    }),

  // POST /trpc/conversations.addMessage
  addMessage: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        role: z.nativeEnum(MessageRole),
        content: z.string().min(1),
        status: z.nativeEnum(MessageStatus).optional().default(MessageStatus.DONE),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: {
          userId: true,
          agentId: true,
          agent: { select: { slug: true } },
        },
      })

      if (!conversation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found' })
      if (conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      if (input.role === MessageRole.user && !conversation.agent) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Conversation has no agent assigned — cannot process user message',
        })
      }

      const message = await ctx.prisma.message.create({
        data: {
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          status: input.status,
        },
        select: messageSelect,
      })

      if (input.role === MessageRole.user) {
        await enqueueAgentRun({
          runId: crypto.randomUUID(),
          conversationId: input.conversationId,
          messageId: message.id,
          agentSlug: conversation.agent!.slug,
          userMessage: input.content,
          mode: 'inline',
        })
      }

      return message
    }),

  // PATCH /trpc/conversations.updateMessageStatus
  updateMessageStatus: protectedProcedure
    .input(
      z.object({
        messageId: z.string(),
        status: z.nativeEnum(MessageStatus),
        content: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const message = await ctx.prisma.message.findUnique({
        where: { id: input.messageId },
        select: { conversation: { select: { userId: true } } },
      })

      if (!message) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' })
      if (message.conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      return ctx.prisma.message.update({
        where: { id: input.messageId },
        data: {
          status: input.status,
          ...(input.content !== undefined && { content: input.content }),
        },
        select: messageSelect,
      })
    }),

  // GET /trpc/conversations.messages?input={"conversationId":"..."}
  messages: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { userId: true },
      })

      if (!conversation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found' })
      if (conversation.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' })
      }

      const items = await ctx.prisma.message.findMany({
        where: { conversationId: input.conversationId },
        select: messageSelect,
        orderBy: { createdAt: 'asc' },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      })

      const hasMore = items.length > input.limit
      const messages = hasMore ? items.slice(0, input.limit) : items

      return {
        messages,
        nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
      }
    }),
})
