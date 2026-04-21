'use client'

import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, ChevronDown, Check, Loader2, MessageSquare, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'
import { FeedbackButton } from './feedback-button'
import { FeedbackModal } from './feedback-modal'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type AgentKey = 'Auto' | 'CEO' | 'CPO' | 'CMO' | 'CTO' | 'CFO' | 'CLO'

const agentConfig: Record<AgentKey, { avatarBg: string; dot: string; label: string; subtitle: string }> = {
  Auto: { avatarBg: 'bg-zinc-600', dot: 'bg-zinc-400', label: 'Auto', subtitle: 'Automatic selection' },
  CEO: { avatarBg: 'bg-green-600', dot: 'bg-green-500', label: 'CEO', subtitle: 'Strategy & Vision' },
  CPO: { avatarBg: 'bg-violet-600', dot: 'bg-violet-500', label: 'CPO', subtitle: 'Product & Design' },
  CMO: { avatarBg: 'bg-amber-600', dot: 'bg-amber-500', label: 'CMO', subtitle: 'Marketing & Content' },
  CTO: { avatarBg: 'bg-blue-600', dot: 'bg-blue-500', label: 'CTO', subtitle: 'Engineering & Tech' },
  CFO: { avatarBg: 'bg-emerald-600', dot: 'bg-emerald-500', label: 'CFO', subtitle: 'Finance & Strategy' },
  CLO: { avatarBg: 'bg-rose-600', dot: 'bg-rose-500', label: 'CLO', subtitle: 'Legal & Compliance' },
}

const agentEntries = Object.entries(agentConfig) as [AgentKey, (typeof agentConfig)[AgentKey]][]

function resolveAgentConfig(agentName?: string | null) {
  if (!agentName) return agentConfig.Auto
  const key = agentName.toUpperCase() as AgentKey
  return agentConfig[key] ?? agentConfig.Auto
}

/* ---------- Empty state (no conversation selected) ---------- */
function NoConversation() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center">
        <MessageSquare className="w-5 h-5 text-zinc-500" />
      </div>
      <div>
        <p className="text-sm font-medium text-zinc-400">No conversation selected</p>
        <p className="text-xs text-zinc-600 mt-1">Pick one from the list or start a new chat</p>
      </div>
    </div>
  )
}

/* ---------- Message skeleton ---------- */
function MessageSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5 animate-pulse">
      <div className="flex justify-end">
        <div className="h-9 w-48 bg-zinc-800 rounded-2xl rounded-br-sm" />
      </div>
      <div className="flex items-start gap-3 max-w-[85%]">
        <div className="w-7 h-7 rounded-full bg-zinc-800 shrink-0 mt-0.5" />
        <div className="flex-1 space-y-2">
          <div className="h-9 bg-zinc-800 rounded-2xl rounded-tl-sm" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="h-7 w-36 bg-zinc-800 rounded-2xl rounded-br-sm" />
      </div>
    </div>
  )
}

/* ---------- Chat Thread ---------- */
interface ChatThreadProps {
  conversationId: string | null
}

export function ChatThread({ conversationId }: ChatThreadProps) {
  const utils = trpc.useUtils()
  const [selectedAgent, setSelectedAgent] = useState<AgentKey>('Auto')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const [activeFeedback, setActiveFeedback] = useState<{
    feedbackId: string
    userMessage: string
  } | null>(null)

  const { data: conversation, isLoading } = trpc.conversations.byId.useQuery(
    { id: conversationId! },
    { enabled: !!conversationId }
  )

  const addMessage = trpc.conversations.addMessage.useMutation({
    onSuccess: () => {
      utils.conversations.byId.invalidate({ id: conversationId! })
      utils.conversations.list.invalidate()
    },
  })

  const messages = conversation?.messages ?? []

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // Sync agent selector with conversation's assigned agent
  useEffect(() => {
    if (conversation?.agent) {
      const key = conversation.agent.name.toUpperCase() as AgentKey
      if (key in agentConfig) setSelectedAgent(key)
    }
  }, [conversation?.agent])

  function handleSend() {
    if (!input.trim() || !conversationId || addMessage.isPending) return

    // On the first message, lock the selected agent to this conversation.
    // 'Auto' means no preference — backend picks the default MANAGER agent.
    const agentSlug = !conversation?.agentId && selectedAgent !== 'Auto'
      ? selectedAgent.toLowerCase()
      : undefined

    addMessage.mutate({ conversationId, role: 'user', content: input.trim(), agentSlug })
    setInput('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const agent = agentConfig[selectedAgent]
  const isAgentLocked = !!conversation?.agentId

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
            onClick={isAgentLocked ? undefined : () => setDropdownOpen(!dropdownOpen)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium',
              isAgentLocked
                ? 'cursor-default opacity-80'
                : 'hover:bg-zinc-800 transition-colors cursor-pointer'
            )}
          >
            <span className={cn('w-2 h-2 rounded-full shrink-0', agent.dot)} />
            <span className="text-zinc-200">@{selectedAgent}</span>
            {isAgentLocked ? (
              <Lock className="w-3 h-3 text-zinc-600" />
            ) : (
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            )}
          </button>

          {dropdownOpen && !isAgentLocked && (
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
                    selectedAgent === key && 'bg-zinc-800/60'
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full shrink-0', cfg.dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-200">{cfg.label}</p>
                    <p className="text-[10px] text-zinc-500">{cfg.subtitle}</p>
                  </div>
                  {selectedAgent === key && <Check className="w-3 h-3 text-indigo-400 shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {!conversationId ? (
        <NoConversation />
      ) : isLoading ? (
        <MessageSkeleton />
      ) : messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
          <p className="text-sm font-medium text-zinc-400">Start the conversation</p>
          <p className="text-xs text-zinc-600">
            {isAgentLocked
              ? `Send a message to @${selectedAgent} below`
              : 'Pick an agent above, then send your first message'}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[75%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              )
            }

            const cfg = resolveAgentConfig(conversation?.agent?.name)
            // Find the user message that preceded this assistant message
            // (used as the label in the feedback modal)
            const msgIdx = messages.findIndex((m) => m.id === msg.id)
            const precedingUserMsg = msgIdx > 0
              ? [...messages].slice(0, msgIdx).reverse().find((m) => m.role === 'user')
              : undefined

            return (
              <div key={msg.id} className="flex items-start gap-3 max-w-[85%] group">
                <div
                  className={cn(
                    'w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white mt-0.5',
                    cfg.avatarBg
                  )}
                >
                  {conversation?.agent?.name?.slice(0, 3).toUpperCase() ?? 'AI'}
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      'bg-zinc-800 text-zinc-100 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed',
                      msg.status === 'STREAMING' && 'after:inline-block after:w-1 after:h-3.5 after:bg-indigo-400 after:ml-0.5 after:animate-pulse after:rounded-sm after:align-middle'
                    )}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0 text-zinc-200">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>,
                        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                        em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
                        blockquote: ({ children }) => (
                          <blockquote className="border-l-2 border-indigo-500 pl-3 my-2 text-zinc-300 italic">
                            {children}
                          </blockquote>
                        ),
                        hr: () => <hr className="border-zinc-700 my-3" />,
                        code: ({ children, className }) => {
                          const isBlock = className?.includes('language-')
                          return isBlock ? (
                            <code className="block bg-zinc-900 rounded-lg p-3 my-2 text-xs font-mono text-zinc-200 overflow-x-auto whitespace-pre">
                              {children}
                            </code>
                          ) : (
                            <code className="bg-zinc-900 rounded px-1 py-0.5 text-xs font-mono text-indigo-300">
                              {children}
                            </code>
                          )
                        },
                        table: ({ children }) => (
                          <div className="overflow-x-auto my-2">
                            <table className="text-xs border-collapse w-full">{children}</table>
                          </div>
                        ),
                        th: ({ children }) => (
                          <th className="border border-zinc-700 px-2 py-1 bg-zinc-900 font-semibold text-left">{children}</th>
                        ),
                        td: ({ children }) => (
                          <td className="border border-zinc-700 px-2 py-1">{children}</td>
                        ),
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                  {msg.status === 'FAILED' && (
                    <p className="text-[10px] text-red-400 mt-1 px-1">Failed to generate response</p>
                  )}
                  {msg.status === 'DONE' && (
                    <FeedbackButton
                      messageId={msg.id}
                      onFeedbackSubmitted={(feedbackId) =>
                        setActiveFeedback({
                          feedbackId,
                          userMessage: precedingUserMsg?.content ?? msg.content.slice(0, 80),
                        })
                      }
                    />
                  )}
                </div>
              </div>
            )
          })}

          {/* Pending indicator while agent is thinking */}
          {addMessage.isPending && (
            <div className="flex items-start gap-3 max-w-[85%]">
              <div className={cn('w-7 h-7 rounded-full shrink-0 flex items-center justify-center mt-0.5', agent.avatarBg)}>
                <Loader2 className="w-3 h-3 text-white animate-spin" />
              </div>
              <div className="bg-zinc-800 rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {/* Feedback analysis modal */}
      {activeFeedback && (
        <FeedbackModal
          feedbackId={activeFeedback.feedbackId}
          userMessage={activeFeedback.userMessage}
          onClose={() => setActiveFeedback(null)}
          onRerun={() => {
            if (!conversationId) return
            addMessage.mutate({
              conversationId,
              role: 'user',
              content: activeFeedback.userMessage,
            })
          }}
        />
      )}

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-zinc-800">
        <p className="text-[10px] text-zinc-600 mb-1.5 px-1">
          Use <span className="text-zinc-500">@</span> to mention an agent directly · Enter to send
        </p>
        <div className="flex items-center gap-3 bg-zinc-800 rounded-xl px-4 h-14 focus-within:ring-1 focus-within:ring-indigo-500/40 transition-all">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={conversationId ? `Message @${selectedAgent}…` : 'Select a conversation first'}
            disabled={!conversationId || addMessage.isPending}
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-500 outline-none disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !conversationId || addMessage.isPending}
            className="w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
          >
            {addMessage.isPending ? (
              <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5 text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
