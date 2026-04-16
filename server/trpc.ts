import { initTRPC, TRPCError } from '@trpc/server'
import { prisma } from '@/lib/prisma'

export interface Context {
  prisma: typeof prisma
}

export function createContext(): Context {
  return { prisma }
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

export { TRPCError }
