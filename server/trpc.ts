import { initTRPC, TRPCError } from '@trpc/server'
import type { User } from '@prisma/client'
import type { Session } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { auth } from '@/auth'

export interface Context {
  prisma: typeof prisma
  session: Session | null
}

export async function createContext(): Promise<Context> {
  const session = (await auth()) as Session | null
  return { prisma, session }
}

const t = initTRPC.context<Context>().create()

export const router = t.router

export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.address) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' })
  }

  const user = await ctx.prisma.user.upsert({
    where: { walletAddress: ctx.session.address },
    create: { walletAddress: ctx.session.address },
    update: {},
  })

  return next({ ctx: { ...ctx, user } })
})

export type ProtectedContext = Context & { user: User }

export { TRPCError }
