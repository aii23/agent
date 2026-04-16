'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentColors } from './agent-list'
import type { AgentListItem } from '@/types/agents'

interface DelegateEditorProps {
  currentDelegates: AgentListItem[]
  availableExecutors: AgentListItem[]
  onChange: (ids: string[]) => void
}

export function DelegateEditor({
  currentDelegates,
  availableExecutors,
  onChange,
}: DelegateEditorProps) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const delegateIds = new Set(currentDelegates.map((d) => d.id))
  const addable = availableExecutors.filter((e) => !delegateIds.has(e.id))

  function remove(id: string) {
    onChange(currentDelegates.filter((d) => d.id !== id).map((d) => d.id))
  }

  function add(id: string) {
    onChange([...currentDelegates.map((d) => d.id), id])
    setOpen(false)
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3 space-y-2">
      {/* Current delegate tags */}
      {currentDelegates.length === 0 ? (
        <p className="text-xs text-zinc-600 italic">No executors assigned yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {currentDelegates.map((d) => {
            const colors = agentColors[d.slug]?.pill ?? 'bg-zinc-700/50 text-zinc-400 border border-zinc-700'
            return (
              <span
                key={d.id}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium',
                  colors
                )}
              >
                {d.name}
                <button
                  type="button"
                  onClick={() => remove(d.id)}
                  className="opacity-60 hover:opacity-100 transition-opacity"
                  aria-label={`Remove ${d.name}`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Add executor dropdown */}
      <div ref={dropdownRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={addable.length === 0}
          className={cn(
            'w-full flex items-center justify-between gap-2 h-7 px-3 rounded-lg border text-xs transition-colors',
            addable.length === 0
              ? 'border-zinc-800 text-zinc-600 cursor-not-allowed'
              : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          )}
        >
          <span>{addable.length === 0 ? 'All executors assigned' : '+ Add executor...'}</span>
          {addable.length > 0 && <ChevronDown className="w-3 h-3 shrink-0 text-zinc-500" />}
        </button>

        {open && addable.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1.5 w-full rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/50 py-1 z-20 max-h-48 overflow-y-auto">
            {addable.map((executor) => (
              <button
                key={executor.id}
                type="button"
                onClick={() => add(executor.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-zinc-200 truncate">{executor.name}</p>
                  <p className="text-[10px] text-zinc-500 truncate">{executor.role}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
