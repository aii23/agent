'use client'

import { ListTree, ChevronRight, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PlanStatusBadge } from './status-badge'
import { trpc } from '@/lib/trpc'
import type { ExecutionPlanStatus, StepStatus } from '@prisma/client'

type PlanListItem = {
  id: string
  managerSlug: string
  status: ExecutionPlanStatus
  currentStepIndex: number
  createdAt: Date | string
  updatedAt: Date | string
  conversation: { id: string; title: string | null }
  executionSteps: { id: string; status: StepStatus }[]
}

interface ExecutionListProps {
  activeId: string | null
  onSelect: (id: string) => void
}

export function ExecutionList({ activeId, onSelect }: ExecutionListProps) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.executions.list.useInfiniteQuery(
      { limit: 30 },
      { getNextPageParam: (last) => last.nextCursor }
    )

  const plans = data?.pages.flatMap((p) => p.plans) ?? []

  return (
    <div className="w-[300px] shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <ListTree className="w-4 h-4 text-indigo-400 shrink-0" />
          <p className="text-sm font-semibold text-zinc-100">Executions</p>
          {plans.length > 0 && (
            <span className="ml-auto text-[10px] text-zinc-500 font-mono">{plans.length}</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">Execution plans created from chat messages</p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          </div>
        ) : plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 px-4 text-center">
            <ListTree className="w-6 h-6 text-zinc-700" />
            <p className="text-xs text-zinc-600">No execution plans yet</p>
          </div>
        ) : (
          <div className="px-2 py-2 space-y-0.5">
            {plans.map((plan) => (
              <PlanRow
                key={plan.id}
                plan={plan}
                isActive={activeId === plan.id}
                onClick={() => onSelect(plan.id)}
              />
            ))}
            {hasNextPage && (
              <button
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
              >
                {isFetchingNextPage ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanRow({
  plan,
  isActive,
  onClick,
}: {
  plan: PlanListItem
  isActive: boolean
  onClick: () => void
}) {
  const doneSteps = plan.executionSteps.filter((s) => s.status === 'DONE').length
  const totalSteps = plan.executionSteps.length

  return (
    <button
      onClick={onClick}
      className={cn(
        'relative w-full text-left px-2.5 py-2.5 rounded-lg transition-all duration-100',
        isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
      )}
    >
      {isActive && (
        <span className="absolute left-0 inset-y-[5px] w-0.5 bg-indigo-500 rounded-r" />
      )}

      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Conversation title */}
          <div className="flex items-center gap-1.5 mb-1">
            <MessageSquare className="w-3 h-3 text-zinc-600 shrink-0" />
            <p className="text-[11px] text-zinc-500 truncate">
              {plan.conversation.title ?? `Conversation ${plan.conversation.id.slice(0, 8)}`}
            </p>
          </div>

          {/* Manager + status */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-medium text-zinc-300 truncate">
              {plan.managerSlug}
            </span>
            <PlanStatusBadge status={plan.status} />
          </div>

          {/* Steps progress + date */}
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-zinc-600">
              {totalSteps > 0 ? `${doneSteps}/${totalSteps} steps` : 'No steps'}
            </span>
            <span className="text-[10px] text-zinc-600">
              {formatRelative(plan.createdAt)}
            </span>
          </div>
        </div>
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 shrink-0 mt-0.5 transition-colors',
            isActive ? 'text-zinc-400' : 'text-zinc-700'
          )}
        />
      </div>
    </button>
  )
}

function formatRelative(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString()
}
