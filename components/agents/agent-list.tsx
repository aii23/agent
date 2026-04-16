'use client'

import { Search } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { AgentListItem } from '@/types/agents'

// Colour map keyed by slug — matches agentPillColors in conversation-list
export const agentColors: Record<string, { pill: string; dot: string; dotFilled: string }> = {
  ceo: {
    pill: 'bg-green-500/15 text-green-400 border border-green-500/20',
    dot: 'border-2 border-green-500',
    dotFilled: 'bg-green-500',
  },
  cpo: {
    pill: 'bg-violet-500/15 text-violet-400 border border-violet-500/20',
    dot: 'border-2 border-violet-500',
    dotFilled: 'bg-violet-500',
  },
  cmo: {
    pill: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
    dot: 'border-2 border-amber-500',
    dotFilled: 'bg-amber-500',
  },
  cto: {
    pill: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
    dot: 'border-2 border-blue-500',
    dotFilled: 'bg-blue-500',
  },
  cfo: {
    pill: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
    dot: 'border-2 border-emerald-500',
    dotFilled: 'bg-emerald-500',
  },
  clo: {
    pill: 'bg-rose-500/15 text-rose-400 border border-rose-500/20',
    dot: 'border-2 border-rose-500',
    dotFilled: 'bg-rose-500',
  },
}

const DEFAULT_COLORS = {
  pill: 'bg-zinc-700/50 text-zinc-400 border border-zinc-700',
  dot: 'border-2 border-zinc-500',
  dotFilled: 'bg-zinc-500',
}

function getColors(slug: string) {
  return agentColors[slug] ?? DEFAULT_COLORS
}

interface AgentListProps {
  agents: AgentListItem[]
  activeId: string | null
  onSelect: (id: string) => void
  loading?: boolean
}

export function AgentList({ agents, activeId, onSelect, loading }: AgentListProps) {
  const [search, setSearch] = useState('')

  const filtered = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.role.toLowerCase().includes(search.toLowerCase())
  )

  const managers = filtered
    .filter((a) => a.agentType === 'MANAGER')
    .sort((a, b) => a.name.localeCompare(b.name))

  const executors = filtered
    .filter((a) => a.agentType === 'EXECUTOR')
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="w-[280px] shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-zinc-800 shrink-0">
        <p className="text-sm font-semibold text-zinc-100 mb-2">Agents</p>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full h-7 pl-8 pr-3 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 placeholder:text-zinc-500 outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          </div>
        ) : (
          <>
            <AgentGroup
              label="Managers"
              agents={managers}
              activeId={activeId}
              onSelect={onSelect}
            />
            <AgentGroup
              label="Executors"
              agents={executors}
              activeId={activeId}
              onSelect={onSelect}
            />
          </>
        )}
      </div>
    </div>
  )
}

function AgentGroup({
  label,
  agents,
  activeId,
  onSelect,
}: {
  label: string
  agents: AgentListItem[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (agents.length === 0) return null

  return (
    <div className="mb-3 mt-2">
      <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
        {label}
      </p>
      <div className="space-y-0.5">
        {agents.map((agent) => {
          const colors = getColors(agent.slug)
          const isActive = activeId === agent.id
          const isManager = agent.agentType === 'MANAGER'

          return (
            <button
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className={cn(
                'relative w-full text-left px-2.5 py-2 rounded-lg transition-all duration-100',
                isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
              )}
            >
              {isActive && (
                <span className="absolute left-0 inset-y-[5px] w-0.5 bg-indigo-500 rounded-r" />
              )}
              <div className="flex items-center gap-2">
                {/* Filled circle for managers, outline for executors */}
                <span
                  className={cn(
                    'w-2 h-2 rounded-full shrink-0',
                    isManager ? colors.dotFilled : colors.dot
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-xs font-medium truncate',
                      isActive ? 'text-zinc-100' : 'text-zinc-300'
                    )}
                  >
                    {agent.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 truncate">{agent.role}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
