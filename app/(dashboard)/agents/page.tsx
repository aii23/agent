'use client'

import { useState } from 'react'
import { Bot } from 'lucide-react'
import { AgentList } from '@/components/agents/agent-list'
import { AgentDetail } from '@/components/agents/agent-detail'
import { trpc } from '@/lib/trpc'
import type { AgentListItem, AgentType } from '@/types/agents'

export default function AgentsPage() {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState<AgentType | null>(null)

  const utils = trpc.useUtils()
  const { data: agents = [], isLoading } = trpc.agents.list.useQuery()
  const createMutation = trpc.agents.create.useMutation({
    onSuccess: (newAgent: { id: string }) => {
      utils.agents.list.invalidate()
      setActiveId(newAgent.id)
      setCreating(null)
    },
    onError: () => setCreating(null),
  })

  function handleCreate(agentType: AgentType) {
    setCreating(agentType)
    createMutation.mutate({ agentType })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentList = agents as any[]

  const listItems: AgentListItem[] = agentList.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    role: a.role,
    agentType: a.agentType,
  }))

  const allExecutors: AgentListItem[] = agentList
    .filter((a) => a.agentType === 'EXECUTOR')
    .map((a) => ({ id: a.id, slug: a.slug, name: a.name, role: a.role, agentType: a.agentType }))

  return (
    <div className="flex h-full overflow-hidden">
      <AgentList
        agents={listItems}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        creating={creating}
        loading={isLoading}
      />

      {activeId ? (
        <AgentDetail key={activeId} agentId={activeId} allExecutors={allExecutors} />
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950">
      <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center">
        <Bot className="w-5 h-5 text-zinc-500" />
      </div>
      <p className="text-sm text-zinc-500">
        Select an agent from the list to view and edit its configuration.
      </p>
    </div>
  )
}
