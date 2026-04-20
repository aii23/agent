import { router } from '../trpc'
import { agentsRouter } from './agents'
import { conversationsRouter } from './conversations'
import { executionsRouter } from './executions'

export const appRouter = router({
  agents: agentsRouter,
  conversations: conversationsRouter,
  executions: executionsRouter,
})

export type AppRouter = typeof appRouter
