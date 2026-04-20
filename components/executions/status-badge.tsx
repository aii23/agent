import { cn } from '@/lib/utils'
import type { ExecutionPlanStatus, StepStatus } from '@prisma/client'

const planStatusConfig: Record<ExecutionPlanStatus, { label: string; className: string }> = {
  PLANNING: {
    label: 'Planning',
    className: 'bg-amber-500/15 text-amber-400 border border-amber-500/25',
  },
  EXECUTING: {
    label: 'Executing',
    className: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
  },
  SYNTHESIZING: {
    label: 'Synthesizing',
    className: 'bg-violet-500/15 text-violet-400 border border-violet-500/25',
  },
  DONE: {
    label: 'Done',
    className: 'bg-green-500/15 text-green-400 border border-green-500/25',
  },
  FAILED: {
    label: 'Failed',
    className: 'bg-red-500/15 text-red-400 border border-red-500/25',
  },
}

const stepStatusConfig: Record<StepStatus, { label: string; className: string; dotClass: string }> =
  {
    PENDING: {
      label: 'Pending',
      className: 'text-zinc-400',
      dotClass: 'bg-zinc-600',
    },
    RUNNING: {
      label: 'Running',
      className: 'text-blue-400',
      dotClass: 'bg-blue-500 animate-pulse',
    },
    DONE: {
      label: 'Done',
      className: 'text-green-400',
      dotClass: 'bg-green-500',
    },
    FAILED: {
      label: 'Failed',
      className: 'text-red-400',
      dotClass: 'bg-red-500',
    },
  }

export function PlanStatusBadge({ status }: { status: ExecutionPlanStatus }) {
  const cfg = planStatusConfig[status]
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium',
        cfg.className
      )}
    >
      {cfg.label}
    </span>
  )
}

export function StepStatusIndicator({ status }: { status: StepStatus }) {
  const cfg = stepStatusConfig[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', cfg.className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', cfg.dotClass)} />
      {cfg.label}
    </span>
  )
}
