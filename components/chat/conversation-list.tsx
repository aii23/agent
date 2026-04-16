'use client'

import { useState } from 'react'
import { Plus, Search, Loader2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'

const agentPillColors: Record<string, string> = {
  cmo: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
  cpo: 'bg-violet-500/15 text-violet-400 border border-violet-500/20',
  ceo: 'bg-green-500/15 text-green-400 border border-green-500/20',
  cto: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
  cfo: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
  clo: 'bg-rose-500/15 text-rose-400 border border-rose-500/20',
}

function agentPill(slug: string) {
  return agentPillColors[slug.toLowerCase()] ?? 'bg-zinc-700/50 text-zinc-400 border border-zinc-600/30'
}

function getTimeGroup(date: Date | string): 'Today' | 'Yesterday' | 'Older' {
  const now = new Date()
  const d = new Date(date)
  if (d.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return 'Older'
}

function getTimeLabel(date: Date | string): string {
  const diff = Date.now() - new Date(date).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

const GROUPS = ['Today', 'Yesterday', 'Older'] as const

interface ConversationListProps {
  activeId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  isCreating?: boolean
}

export function ConversationList({ activeId, onSelect, onNewChat, isCreating }: ConversationListProps) {
  const [search, setSearch] = useState('')
  const { data: conversations = [], isLoading } = trpc.conversations.list.useQuery()

  const filtered = conversations.filter((c) => {
    const title = c.title ?? c.messages[0]?.content ?? ''
    return title.toLowerCase().includes(search.toLowerCase())
  })

  return (
    <div className="w-[280px] shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950 overflow-hidden">
      {/* New Chat */}
      <div className="p-3 border-b border-zinc-800 shrink-0">
        <button
          onClick={onNewChat}
          disabled={isCreating}
          className="w-full flex items-center justify-center gap-2 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {isCreating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading ? (
          <LoadingSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState hasSearch={search.length > 0} />
        ) : (
          GROUPS.map((group) => {
            const items = filtered.filter((c) => getTimeGroup(c.createdAt) === group)
            if (items.length === 0) return null
            return (
              <div key={group} className="mb-3">
                <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  {group}
                </p>
                <div className="space-y-0.5">
                  {items.map((conv) => {
                    const title = conv.title ?? conv.messages[0]?.content ?? 'New conversation'
                    const preview = title.length > 40 ? title.slice(0, 40) + '…' : title
                    return (
                      <button
                        key={conv.id}
                        onClick={() => onSelect(conv.id)}
                        className={cn(
                          'relative w-full text-left px-2.5 py-2 rounded-lg transition-all duration-100',
                          activeId === conv.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
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
                            {preview}
                          </p>
                          <span className="text-[10px] text-zinc-500 shrink-0">
                            {getTimeLabel(conv.createdAt)}
                          </span>
                        </div>
                        {conv.agent && (
                          <div>
                            <span
                              className={cn(
                                'inline-flex text-[9px] font-semibold px-1.5 py-0.5 rounded',
                                agentPill(conv.agent.slug)
                              )}
                            >
                              {conv.agent.name.toUpperCase()}
                            </span>
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="px-2 pt-2 space-y-1 animate-pulse">
      {[80, 65, 90, 70, 55].map((w, i) => (
        <div key={i} className="px-2.5 py-2 rounded-lg">
          <div className="flex justify-between mb-1.5">
            <div className={`h-2.5 bg-zinc-800 rounded`} style={{ width: `${w}%` }} />
            <div className="h-2.5 w-5 bg-zinc-800 rounded" />
          </div>
          <div className="h-2 w-10 bg-zinc-800/60 rounded" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <MessageSquare className="w-8 h-8 text-zinc-700 mb-3" />
      <p className="text-xs font-medium text-zinc-500">
        {hasSearch ? 'No conversations match' : 'No conversations yet'}
      </p>
      {!hasSearch && (
        <p className="text-[10px] text-zinc-600 mt-1">Click New Chat to get started</p>
      )}
    </div>
  )
}
