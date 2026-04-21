import { router } from '../trpc'
import { agentsRouter } from './agents'
import { conversationsRouter } from './conversations'
import { executionsRouter } from './executions'
import { feedbackRouter } from './feedback'

export const appRouter = router({
  agents: agentsRouter,
  conversations: conversationsRouter,
  executions: executionsRouter,
  feedback: feedbackRouter,
})

export type AppRouter = typeof appRouter
