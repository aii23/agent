'use client'

import { useState } from 'react'
import { ListTree, MessageSquare, ChevronDown, ChevronRight, Clock, Bot, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PlanStatusBadge, StepStatusIndicator } from './status-badge'
import { trpc } from '@/lib/trpc'

interface ExecutionDetailProps {
  planId: string
}

export function ExecutionDetail({ planId }: ExecutionDetailProps) {
  const { data: plan, isLoading, error } = trpc.executions.byId.useQuery({ id: planId })

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <div className="w-5 h-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (error || !plan) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-zinc-950">
        <p className="text-sm text-red-400">Failed to load execution plan</p>
        <p className="text-xs text-zinc-600">{error?.message}</p>
      </div>
    )
  }

  const doneSteps = plan.executionSteps.filter((s) => s.status === 'DONE').length
  const totalSteps = plan.executionSteps.length
  // Prisma's JsonValue is a deeply-recursive type that exhausts TypeScript's
  // instantiation depth. Cast through any to break the chain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planStepsJson: unknown = (plan as any).steps
  const durationMs =
    plan.updatedAt && plan.createdAt
      ? new Date(plan.updatedAt).getTime() - new Date(plan.createdAt).getTime()
      : null

  return (
    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <ListTree className="w-4 h-4 text-indigo-400 shrink-0" />
              <h1 className="text-sm font-semibold text-zinc-100 font-mono truncate">
                {plan.id.slice(0, 8)}…{plan.id.slice(-6)}
              </h1>
              <PlanStatusBadge status={plan.status} />
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1">
                <Bot className="w-3 h-3" />
                {plan.managerSlug}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {plan.conversation.title ?? `Conv ${plan.conversation.id.slice(0, 8)}`}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(plan.createdAt).toLocaleString()}
              </span>
              {durationMs !== null && (
                <span className="text-zinc-600">
                  {durationMs < 1000
                    ? `${durationMs}ms`
                    : `${(durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          </div>

          {/* Step counter */}
          <div className="shrink-0 text-right">
            <div className="text-xl font-bold text-zinc-200 font-mono">
              {doneSteps}
              <span className="text-sm text-zinc-600">/{totalSteps}</span>
            </div>
            <div className="text-[10px] text-zinc-600 uppercase tracking-wide">steps done</div>
          </div>
        </div>

        {/* Progress bar */}
        {totalSteps > 0 && (
          <div className="mt-3 h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-500"
              style={{ width: `${(doneSteps / totalSteps) * 100}%` }}
            />
          </div>
        )}
      </div>

      {/* Metadata panels (collapsible) */}
      <div className="shrink-0 border-b border-zinc-800">
        <MetaPanel label="Plan steps (raw JSON)" value={planStepsJson} defaultOpen={false} />
        {plan.synthesisPrompt && (
          <MetaPanel label="Synthesis prompt" value={plan.synthesisPrompt} isString defaultOpen={false} />
        )}
        {plan.notionContext && (
          <MetaPanel label="Notion context" value={plan.notionContext} isString defaultOpen={false} />
        )}
      </div>

      {/* Execution steps */}
      <div className="flex-1 overflow-y-auto">
        {plan.executionSteps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-center px-4">
            <p className="text-xs text-zinc-600">No execution steps recorded yet</p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {plan.executionSteps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Step Card ────────────────────────────────────────────────────────────────

type ExecutionStep = {
  id: string
  stepIndex: number
  agentSlug: string
  resolvedPrompt: string
  output: string | null
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  createdAt: Date | string
  completedAt: Date | string | null
}

function StepCard({ step }: { step: ExecutionStep }) {
  const [expanded, setExpanded] = useState(step.status === 'FAILED')

  const durationMs =
    step.completedAt && step.createdAt
      ? new Date(step.completedAt).getTime() - new Date(step.createdAt).getTime()
      : null

  return (
    <div
      className={cn(
        'rounded-xl border transition-colors',
        step.status === 'FAILED'
          ? 'border-red-500/30 bg-red-950/20'
          : step.status === 'RUNNING'
            ? 'border-blue-500/30 bg-blue-950/10'
            : 'border-zinc-800 bg-zinc-900/50'
      )}
    >
      {/* Step header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        {/* Step index badge */}
        <span className="w-6 h-6 rounded-md bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-400 font-mono shrink-0">
          {step.stepIndex + 1}
        </span>

        {/* Agent slug */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-200 font-mono">{step.agentSlug}</span>
            <StepStatusIndicator status={step.status} />
          </div>
          {/* Prompt preview */}
          {!expanded && (
            <p className="mt-0.5 text-[11px] text-zinc-500 truncate">{step.resolvedPrompt}</p>
          )}
        </div>

        {/* Duration */}
        {durationMs !== null && (
          <span className="shrink-0 text-[10px] text-zinc-600 font-mono">
            {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}

        {/* Chevron */}
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-800/60 pt-3">
          {/* Timestamps */}
          <div className="flex gap-4 text-[10px] text-zinc-600">
            <span>Created: {new Date(step.createdAt).toLocaleTimeString()}</span>
            {step.completedAt && (
              <span>Completed: {new Date(step.completedAt).toLocaleTimeString()}</span>
            )}
          </div>

          {/* Resolved prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                Resolved Prompt
              </p>
              <CopyButton text={step.resolvedPrompt} />
            </div>
            <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap bg-zinc-800/60 rounded-lg p-3 leading-relaxed max-h-64 overflow-y-auto font-mono">
              {step.resolvedPrompt}
            </pre>
          </div>

          {/* Output */}
          {step.output !== null && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Output
                </p>
                <CopyButton text={step.output} />
              </div>
              <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap bg-zinc-800/60 rounded-lg p-3 leading-relaxed max-h-80 overflow-y-auto font-mono">
                {step.output}
              </pre>
            </div>
          )}

          {step.status === 'PENDING' && step.output === null && (
            <p className="text-[11px] text-zinc-600 italic">No output yet — step is pending</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Meta panel ───────────────────────────────────────────────────────────────

function MetaPanel({
  label,
  value,
  isString = false,
  defaultOpen = false,
}: {
  label: string
  value: unknown
  isString?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const text = isString ? String(value) : JSON.stringify(value, null, 2)

  return (
    <div className="border-b border-zinc-800/50 last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-5 py-2.5 text-left hover:bg-zinc-900/40 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-zinc-600 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
        )}
        <span className="text-[11px] font-medium text-zinc-500">{label}</span>
      </button>
      {open && (
        <div className="px-5 pb-3">
          <div className="relative">
            <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap bg-zinc-800/60 rounded-lg p-3 leading-relaxed max-h-60 overflow-y-auto font-mono">
              {text}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton text={text} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-green-400" />
          <span className="text-green-400">Copied</span>
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          <span>Copy</span>
        </>
      )}
    </button>
  )
}
