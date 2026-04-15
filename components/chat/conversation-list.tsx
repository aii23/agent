'use client'

import { useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

const agentPillColors: Record<string, string> = {
  CMO: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
  CPO: 'bg-violet-500/15 text-violet-400 border border-violet-500/20',
  CEO: 'bg-green-500/15 text-green-400 border border-green-500/20',
  CTO: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
  CFO: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
  CLO: 'bg-rose-500/15 text-rose-400 border border-rose-500/20',
}

const conversations = [
  { id: 1, title: 'Twitter post for AI launch', agent: 'CMO', time: '2m', group: 'Today' },
  { id: 2, title: 'Q3 product roadmap review', agent: 'CPO', time: '1h', group: 'Today' },
  { id: 3, title: 'Competitive analysis report', agent: 'CEO', time: '3h', group: 'Today' },
  { id: 4, title: 'Legal review of new ToS', agent: 'CLO', time: '9h', group: 'Yesterday' },
  { id: 5, title: 'Budget forecast Q4 2024', agent: 'CFO', time: '11h', group: 'Yesterday' },
  { id: 6, title: 'Engineering sprint planning', agent: 'CTO', time: '2d', group: 'Older' },
  { id: 7, title: 'Content calendar November', agent: 'CMO', time: '3d', group: 'Older' },
  { id: 8, title: 'Investor deck narrative', agent: 'CEO', time: '1w', group: 'Older' },
]

const GROUPS = ['Today', 'Yesterday', 'Older']

interface ConversationListProps {
  activeId: number
  onSelect: (id: number) => void
}

export function ConversationList({ activeId, onSelect }: ConversationListProps) {
  const [search, setSearch] = useState('')

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="w-[280px] shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-hidden">
      {/* New Chat */}
      <div className="p-3 border-b border-zinc-800 shrink-0">
        <button className="w-full flex items-center justify-center gap-2 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
          <Plus className="w-3.5 h-3.5" />
          New Chat
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full h-7 pl-8 pr-3 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 placeholder:text-zinc-500 outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Conversation groups */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {GROUPS.map((group) => {
          const items = filtered.filter((c) => c.group === group)
          if (items.length === 0) return null
          return (
            <div key={group} className="mb-3">
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                {group}
              </p>
              <div className="space-y-0.5">
                {items.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => onSelect(conv.id)}
                    className={cn(
                      'relative w-full text-left px-2.5 py-2 rounded-lg transition-all duration-100',
                      activeId === conv.id
                        ? 'bg-zinc-800'
                        : 'hover:bg-zinc-800/50'
                    )}
                  >
                    {activeId === conv.id && (
                      <span className="absolute left-0 inset-y-[5px] w-0.5 bg-indigo-500 rounded-r" />
                    )}
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <p
                        className={cn(
                          'text-xs font-medium truncate',
                          activeId === conv.id ? 'text-zinc-100' : 'text-zinc-300'
                        )}
                      >
                        {conv.title}
                      </p>
                      <span className="text-[10px] text-zinc-500 shrink-0">{conv.time}</span>
                    </div>
                    <div>
                      <span
                        className={cn(
                          'inline-flex text-[9px] font-semibold px-1.5 py-0.5 rounded',
                          agentPillColors[conv.agent] ?? 'bg-zinc-700 text-zinc-400'
                        )}
                      >
                        {conv.agent}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
