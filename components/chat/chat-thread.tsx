'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, ChevronDown, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type AgentKey = 'Auto' | 'CEO' | 'CPO' | 'CMO' | 'CTO' | 'CFO' | 'CLO'

const agentConfig: Record<
  AgentKey,
  { avatarBg: string; dot: string; label: string; subtitle: string }
> = {
  Auto: {
    avatarBg: 'bg-zinc-600',
    dot: 'bg-zinc-400',
    label: 'Auto',
    subtitle: 'Automatic selection',
  },
  CEO: {
    avatarBg: 'bg-green-600',
    dot: 'bg-green-500',
    label: 'CEO',
    subtitle: 'Strategy & Vision',
  },
  CPO: {
    avatarBg: 'bg-violet-600',
    dot: 'bg-violet-500',
    label: 'CPO',
    subtitle: 'Product & Design',
  },
  CMO: {
    avatarBg: 'bg-amber-600',
    dot: 'bg-amber-500',
    label: 'CMO',
    subtitle: 'Marketing & Content',
  },
  CTO: {
    avatarBg: 'bg-blue-600',
    dot: 'bg-blue-500',
    label: 'CTO',
    subtitle: 'Engineering & Tech',
  },
  CFO: {
    avatarBg: 'bg-emerald-600',
    dot: 'bg-emerald-500',
    label: 'CFO',
    subtitle: 'Finance & Strategy',
  },
  CLO: {
    avatarBg: 'bg-rose-600',
    dot: 'bg-rose-500',
    label: 'CLO',
    subtitle: 'Legal & Compliance',
  },
}

/* ---------- Workflow Progress Card ---------- */
function WorkflowProgressCard() {
  return (
    <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-900 p-3 space-y-2.5 text-xs">
      {/* Step 1 — completed */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
            <Check className="w-2.5 h-2.5 text-green-400" />
          </div>
          <span className="font-mono text-zinc-300">content-generator</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-zinc-500">completed</span>
          <span className="text-zinc-600 font-mono">2.3s</span>
        </div>
      </div>
      {/* Step 2 — approved */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
            <Check className="w-2.5 h-2.5 text-green-400" />
          </div>
          <span className="font-mono text-zinc-300">cpo-reviewer</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-zinc-500">approved</span>
          <span className="text-zinc-600 font-mono">1.8s</span>
        </div>
      </div>
      {/* Step 3 — awaiting */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
            <Loader2 className="w-2.5 h-2.5 text-indigo-400 animate-spin" />
          </div>
          <span className="font-mono text-zinc-300">human_gate</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-amber-400">awaiting approval</span>
          <span className="text-zinc-600 font-mono">—</span>
        </div>
      </div>
    </div>
  )
}

/* ---------- Approval Card ---------- */
function ApprovalCard() {
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null)

  if (decision) {
    return (
      <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3">
        <p
          className={cn(
            'text-xs font-medium',
            decision === 'approved' ? 'text-green-400' : 'text-red-400'
          )}
        >
          {decision === 'approved'
            ? 'Post approved and queued for publishing.'
            : 'Post rejected. Returning to drafts.'}
        </p>
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      {/* Tweet draft */}
      <div className="border-l-2 border-indigo-500 pl-3">
        <p className="text-sm text-zinc-200 italic leading-relaxed">
          &ldquo;Next week we&apos;re launching AI features that will change how your
          team works. Smarter agents. Faster workflows. Less busywork. Stay tuned.&rdquo;
        </p>
      </div>
      {/* Char count */}
      <p className="text-xs text-zinc-500">147/280</p>
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDecision('approved')}
          className="h-7 px-3 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors"
        >
          Approve
        </button>
        <button
          onClick={() => setDecision('rejected')}
          className="h-7 px-3 rounded-lg border border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300 text-xs font-medium transition-colors"
        >
          Reject
        </button>
        <button className="h-7 px-3 rounded-lg border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 text-xs font-medium transition-colors">
          Edit
        </button>
      </div>
    </div>
  )
}

/* ---------- Static message data ---------- */
type MessageCard = 'workflow-progress' | 'approval'

interface Message {
  id: number
  type: 'user' | 'assistant'
  agent?: AgentKey
  content: string
  card?: MessageCard
}

const DEMO_MESSAGES: Message[] = [
  {
    id: 1,
    type: 'user',
    content: 'Generate a Twitter post about our new AI features launching next week',
  },
  {
    id: 2,
    type: 'assistant',
    agent: 'CMO',
    content: 'On it. Starting the generate-post workflow...',
    card: 'workflow-progress',
  },
  {
    id: 3,
    type: 'assistant',
    agent: 'CMO',
    content: 'Draft ready for your review:',
    card: 'approval',
  },
]

/* ---------- Chat Thread ---------- */
export function ChatThread() {
  const [selectedAgent, setSelectedAgent] = useState<AgentKey>('CMO')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [])

  const agent = agentConfig[selectedAgent]
  const agentEntries = Object.entries(agentConfig) as [
    AgentKey,
    (typeof agentConfig)[AgentKey],
  ][]

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-zinc-950 overflow-hidden"
      onClick={() => setDropdownOpen(false)}
    >
      {/* Agent selector bar */}
      <div className="shrink-0 px-4 py-2.5 border-b border-zinc-800 flex items-center gap-2">
        <span className="text-xs text-zinc-500">Agent:</span>
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-zinc-800 transition-colors"
          >
            <span className={cn('w-2 h-2 rounded-full shrink-0', agent.dot)} />
            <span className="text-zinc-200">@{selectedAgent}</span>
            <ChevronDown className="w-3 h-3 text-zinc-500" />
          </button>

          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-56 rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/50 py-1 z-20">
              {agentEntries.map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => {
                    setSelectedAgent(key)
                    setDropdownOpen(false)
                  }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 hover:bg-zinc-800 transition-colors text-left',
                    selectedAgent === key ? 'bg-zinc-800/60' : ''
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full shrink-0', cfg.dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-200">{cfg.label}</p>
                    <p className="text-[10px] text-zinc-500">{cfg.subtitle}</p>
                  </div>
                  {selectedAgent === key && (
                    <Check className="w-3 h-3 text-indigo-400 shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
        {DEMO_MESSAGES.map((msg) => {
          if (msg.type === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[75%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed">
                  {msg.content}
                </div>
              </div>
            )
          }

          const cfg = agentConfig[msg.agent!]
          return (
            <div key={msg.id} className="flex items-start gap-3 max-w-[85%]">
              <div
                className={cn(
                  'w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white mt-0.5',
                  cfg.avatarBg
                )}
              >
                {msg.agent}
              </div>
              <div className="flex-1 min-w-0">
                <div className="bg-zinc-800 text-zinc-100 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed">
                  {msg.content}
                </div>
                {msg.card === 'workflow-progress' && <WorkflowProgressCard />}
                {msg.card === 'approval' && <ApprovalCard />}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-zinc-800">
        <p className="text-[10px] text-zinc-600 mb-1.5 px-1">
          Use <span className="text-zinc-500">@</span> to mention an agent directly
        </p>
        <div className="flex items-center gap-3 bg-zinc-800 rounded-xl px-4 h-14 focus-within:ring-1 focus-within:ring-indigo-500/40 transition-all">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message @${selectedAgent}...`}
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-500 outline-none"
          />
          <button className="w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center transition-colors shrink-0">
            <Send className="w-3.5 h-3.5 text-white" />
          </button>
        </div>
      </div>
    </div>
  )
}
