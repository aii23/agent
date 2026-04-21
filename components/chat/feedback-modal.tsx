'use client'

import { useEffect, useState } from 'react'
import { X, Check, Loader2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'
import type { AnalyzerOutput, Fix } from '@/agents/feedback-analyzer'

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000

const LAYER_LABEL: Record<AnalyzerOutput['failedLayer'], string> = {
  router: 'Router',
  planning: 'Planning',
  executor: 'Executor',
  synthesis: 'Synthesis',
  multiple: 'Multiple Layers',
}

const FIX_FIELD_LABEL: Record<Fix['type'], string> = {
  update_prompt: 'System Prompt',
  update_delegatesTo: 'Delegates To',
  update_model: 'Model',
  update_notionScope: 'Notion Scope',
}

// ── Sub-components ─────────────────────────────────────────────────────────

function FixCard({
  fix,
  index,
  feedbackId,
  onApplied,
}: {
  fix: Fix
  index: number
  feedbackId: string
  onApplied: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const applyFix = trpc.feedback.applyFix.useMutation({ onSuccess: onApplied })

  const isApplied = !!fix.applied
  const fieldLabel = FIX_FIELD_LABEL[fix.type]

  function formatValue(v: unknown): string {
    if (Array.isArray(v)) return `[${(v as string[]).join(', ')}]`
    if (typeof v === 'object' && v !== null) return JSON.stringify(v, null, 2)
    return String(v ?? '')
  }

  return (
    <div
      className={cn(
        'rounded-xl border transition-colors',
        isApplied
          ? 'border-zinc-700/50 bg-zinc-900/40'
          : 'border-zinc-700 bg-zinc-900',
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        <span className="text-xs font-semibold text-zinc-200 flex-1">
          {fix.agentSlug}
          <span className="text-zinc-500 font-normal"> · {fieldLabel}</span>
        </span>
        {isApplied && (
          <span className="flex items-center gap-1 text-[10px] text-zinc-500">
            <Check className="w-3 h-3" /> Applied
          </span>
        )}
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Before / After diff */}
          <div className="space-y-2 text-[11px]">
            <div>
              <p className="text-zinc-500 uppercase tracking-wider mb-1">Before</p>
              <pre className="bg-zinc-800/60 rounded-lg px-3 py-2 text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">
                {formatValue(fix.currentValue)}
              </pre>
            </div>
            <div>
              <p className="text-zinc-500 uppercase tracking-wider mb-1">After</p>
              <pre className="bg-indigo-950/50 border border-indigo-900/40 rounded-lg px-3 py-2 text-indigo-200 whitespace-pre-wrap break-words leading-relaxed">
                {formatValue(fix.suggestedValue)}
              </pre>
            </div>
          </div>

          {/* Reasoning */}
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            <span className="text-zinc-400">Why: </span>{fix.reasoning}
          </p>

          {/* Apply button */}
          {!isApplied && (
            <div className="flex justify-end pt-1">
              <button
                onClick={() => applyFix.mutate({ feedbackId, fixIndex: index })}
                disabled={applyFix.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
              >
                {applyFix.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                Apply
              </button>
            </div>
          )}
          {applyFix.isError && (
            <p className="text-[10px] text-red-400 text-right">
              {applyFix.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main modal ─────────────────────────────────────────────────────────────

interface FeedbackModalProps {
  feedbackId: string
  userMessage: string
  onClose: () => void
  onRerun: () => void
}

export function FeedbackModal({
  feedbackId,
  userMessage,
  onClose,
  onRerun,
}: FeedbackModalProps) {
  const [pollEnabled, setPollEnabled] = useState(true)
  const [refetchKey, setRefetchKey] = useState(0)

  const { data, isLoading } = trpc.feedback.get.useQuery(
    { feedbackId },
    {
      refetchInterval: pollEnabled ? POLL_INTERVAL_MS : false,
      staleTime: 0,
    },
  )

  // Stop polling once terminal state is reached
  useEffect(() => {
    if (data?.status === 'completed' || data?.status === 'failed') {
      setPollEnabled(false)
    }
  }, [data?.status])

  const analysis = data?.analysis as AnalyzerOutput | null | undefined
  const allApplied = analysis
    ? analysis.fixes.length > 0 && analysis.fixes.every((f) => f.applied)
    : false
  const pendingFixes = analysis?.fixes.filter((f) => !f.applied) ?? []

  const applyAllFix = trpc.feedback.applyFix.useMutation({
    onSuccess: () => setRefetchKey((k) => k + 1),
  })

  async function handleApplyAll() {
    if (!analysis) return
    for (let i = 0; i < analysis.fixes.length; i++) {
      if (!analysis.fixes[i].applied) {
        await applyAllFix.mutateAsync({ feedbackId, fixIndex: i })
      }
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-200">Analysis</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                &ldquo;{userMessage}&rdquo;
              </p>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body — scrollable */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">

            {/* Loading / analyzing skeleton */}
            {(isLoading || data?.status === 'pending' || data?.status === 'analyzing') && (
              <div className="space-y-3 animate-pulse">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                  <span className="text-xs text-zinc-400">
                    {data?.status === 'analyzing' ? 'Analyzing trace…' : 'Waiting for worker…'}
                  </span>
                </div>
                <div className="h-12 bg-zinc-800 rounded-xl" />
                <div className="h-24 bg-zinc-800 rounded-xl" />
                <div className="h-24 bg-zinc-800 rounded-xl" />
              </div>
            )}

            {/* Failed state */}
            {data?.status === 'failed' && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-950/30 border border-red-900/40">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300">
                  {analysis?.summary
                    ? analysis.summary
                    : 'We identified a problem but couldn\'t generate specific fixes.'}
                </p>
              </div>
            )}

            {/* Completed state */}
            {data?.status === 'completed' && analysis && (
              <>
                {/* Failed layer badge + summary */}
                <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {analysis.failedLayer === 'multiple' ? '🟡' : '🔴'}
                    </span>
                    <span className="text-xs font-semibold text-zinc-200">
                      Failed layer: {LAYER_LABEL[analysis.failedLayer]}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {analysis.summary}
                  </p>
                </div>

                {/* Fix cards */}
                {analysis.fixes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                      Suggested Fixes
                    </p>
                    {analysis.fixes.map((fix, i) => (
                      <FixCard
                        key={i}
                        fix={fix}
                        index={i}
                        feedbackId={feedbackId}
                        onApplied={() => setRefetchKey((k) => k + 1)}
                      />
                    ))}
                  </div>
                )}

                {analysis.fixes.length === 0 && (
                  <p className="text-[11px] text-zinc-500 text-center py-2">
                    No specific fixes identified. The diagnosis above may still be useful.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {data?.status === 'completed' && analysis && (
            <div className="shrink-0 px-5 py-3.5 border-t border-zinc-800 flex items-center justify-between gap-3">
              {allApplied ? (
                <button
                  onClick={() => { onClose(); onRerun() }}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Re-run this message? →
                </button>
              ) : (
                <span />
              )}

              <div className="flex items-center gap-2">
                {pendingFixes.length > 1 && (
                  <button
                    onClick={handleApplyAll}
                    disabled={applyAllFix.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 disabled:opacity-50 text-zinc-300 text-xs font-medium transition-colors"
                  >
                    {applyAllFix.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                    Apply All
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
