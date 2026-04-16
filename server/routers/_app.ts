import { router } from '../trpc'
import { agentsRouter } from './agents'
import { conversationsRouter } from './conversations'

export const appRouter = router({
  agents: agentsRouter,
  conversations: conversationsRouter,
})

export type AppRouter = typeof appRouter
