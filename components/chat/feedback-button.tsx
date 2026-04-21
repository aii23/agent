'use client'

import { useState, useRef, useEffect } from 'react'
import { ThumbsDown, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'

interface FeedbackButtonProps {
  messageId: string
  onFeedbackSubmitted: (feedbackId: string) => void
}

export function FeedbackButton({ messageId, onFeedbackSubmitted }: FeedbackButtonProps) {
  const [state, setState] = useState<'idle' | 'inputting' | 'submitted'>('idle')
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = trpc.feedback.submit.useMutation({
    onSuccess: ({ feedbackId }) => {
      setState('submitted')
      onFeedbackSubmitted(feedbackId)
    },
  })

  // Focus the text input when it appears
  useEffect(() => {
    if (state === 'inputting') {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [state])

  function handleThumbsDown() {
    if (state !== 'idle') return
    setState('inputting')
  }

  function handleSubmit() {
    if (submit.isPending) return
    submit.mutate({ messageId, feedbackText: text.trim() || undefined })
  }

  function handleSkip() {
    if (submit.isPending) return
    submit.mutate({ messageId })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
    if (e.key === 'Escape') { setState('idle'); setText('') }
  }

  if (state === 'submitted') {
    return (
      <span className="text-[10px] text-zinc-600 px-1">
        Analyzing…
      </span>
    )
  }

  if (state === 'inputting') {
    return (
      <div className="flex items-center gap-1.5 mt-1.5">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What was wrong? (optional)"
          maxLength={500}
          disabled={submit.isPending}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-indigo-500/60 disabled:opacity-60 transition-colors"
        />
        <button
          onClick={handleSubmit}
          disabled={submit.isPending}
          title="Submit feedback"
          className="w-6 h-6 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 flex items-center justify-center transition-colors shrink-0"
        >
          <Send className="w-3 h-3 text-white" />
        </button>
        <button
          onClick={handleSkip}
          disabled={submit.isPending}
          title="Skip — submit without comment"
          className="w-6 h-6 rounded-md hover:bg-zinc-700 flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={handleThumbsDown}
      title="This response was unhelpful"
      className={cn(
        'p-1 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800/60 transition-colors',
        'opacity-0 group-hover:opacity-100'
      )}
    >
      <ThumbsDown className="w-3.5 h-3.5" />
    </button>
  )
}
