'use client'

import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'
import { DelegateEditor } from './delegate-editor'
import { agentColors } from './agent-list'
import type { AgentListItem } from '@/types/agents'

const DEFAULT_MODEL = 'claude-sonnet'

interface AgentDetailProps {
  agentId: string
  allExecutors: AgentListItem[]
}

export function AgentDetail({ agentId, allExecutors }: AgentDetailProps) {
  const utils = trpc.useUtils()
  const { data: agent, isLoading } = trpc.agents.byId.useQuery({ id: agentId })

  const updateMutation = trpc.agents.update.useMutation({
    onSuccess: () => {
      utils.agents.byId.invalidate({ id: agentId })
      utils.agents.list.invalidate()
    },
  })
  const setDelegatesMutation = trpc.agents.setDelegates.useMutation({
    onSuccess: () => utils.agents.byId.invalidate({ id: agentId }),
  })

  // Form state — synced from server on load/refetch
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [maxSteps, setMaxSteps] = useState(8)
  const [delegateIds, setDelegateIds] = useState<string[]>([])
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    if (!agent) return
    setName(agent.name)
    setRole(agent.role)
    setDescription(agent.description ?? '')
    setSystemPrompt(agent.systemPrompt)
    setModel(agent.model)
    setMaxSteps(agent.maxSteps)
    setDelegateIds(agent.delegatesTo.map((d) => d.id))
  }, [agent])

  const isDirty =
    agent !== null &&
    agent !== undefined &&
    (name !== agent.name ||
      role !== agent.role ||
      description !== (agent.description ?? '') ||
      systemPrompt !== agent.systemPrompt ||
      model !== agent.model ||
      maxSteps !== agent.maxSteps ||
      !arraysEqual(delegateIds, agent.delegatesTo.map((d) => d.id)))

  const isSaving = updateMutation.isPending || setDelegatesMutation.isPending

  async function save() {
    if (!agent || !isDirty) return
    setSaveStatus('idle')
    try {
      await updateMutation.mutateAsync({ id: agentId, name, role, description, systemPrompt, model, maxSteps })

      if (agent.agentType === 'MANAGER') {
        await setDelegatesMutation.mutateAsync({ managerId: agentId, executorIds: delegateIds })
      }

      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 2500)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Failed to load agent.</p>
      </div>
    )
  }

  const colors = agentColors[agent.slug]
  const isManager = agent.agentType === 'MANAGER'
  const currentDelegates = delegateIds
    .map((id) => allExecutors.find((e) => e.id === id))
    .filter(Boolean) as AgentListItem[]

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-zinc-950 overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-zinc-800">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{name || agent.name}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">{role || agent.role}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Type badge */}
            <span
              className={cn(
                'inline-flex text-[10px] font-semibold px-2 py-0.5 rounded',
                isManager
                  ? (colors?.pill ?? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/20')
                  : 'bg-zinc-700/50 text-zinc-400 border border-zinc-700'
              )}
            >
              {isManager ? 'Manager' : 'Executor'}
            </span>

            {/* Model input */}
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model name"
              className="h-6 px-2.5 rounded-lg border border-zinc-700 bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-colors w-44"
            />
          </div>
        </div>
      </div>

      {/* Form body */}
      <div className="flex-1 px-6 py-5 space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              className="w-full h-8 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
              Role
            </label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Product Manager"
              className="w-full h-8 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Brief description of this agent's purpose..."
            className="w-full px-3 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-colors resize-none leading-relaxed"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
            System Prompt
          </label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder="You are..."
            className="w-full px-3 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-colors resize-none leading-relaxed font-mono"
          />
        </div>

        {isManager && (
          <>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
                Delegates To
              </label>
              <DelegateEditor
                currentDelegates={currentDelegates}
                availableExecutors={allExecutors}
                onChange={setDelegateIds}
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1.5">
                Max Steps
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                className="w-24 h-7 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 outline-none focus:border-indigo-500/50 transition-colors text-center"
              />
              <p className="text-[10px] text-zinc-600 mt-1">
                Maximum planning steps before the manager yields control.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Save bar */}
      <div className="shrink-0 px-6 py-4 border-t border-zinc-800 flex items-center justify-between gap-4">
        <div className="h-5">
          {saveStatus === 'success' && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <Check className="w-3.5 h-3.5" />
              Saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-400">Failed to save. Try again.</span>
          )}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || isSaving}
          className={cn(
            'flex items-center gap-1.5 h-8 px-4 rounded-lg text-xs font-medium transition-colors',
            isDirty && !isSaving
              ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          )}
        >
          {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
          Save Changes
        </button>
      </div>
    </div>
  )
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  return [...a].sort().every((v, i) => v === [...b].sort()[i])
}
