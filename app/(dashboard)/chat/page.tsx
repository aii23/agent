'use client'

import { useState } from 'react'
import { ConversationList } from '@/components/chat/conversation-list'
import { ChatThread } from '@/components/chat/chat-thread'
import { trpc } from '@/lib/trpc'

export default function ChatPage() {
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const utils = trpc.useUtils()

  const createConversation = trpc.conversations.create.useMutation({
    onSuccess: (conv) => {
      setActiveConvId(conv.id)
      utils.conversations.list.invalidate()
    },
  })

  return (
    <div className="flex h-full overflow-hidden">
      <ConversationList
        activeId={activeConvId}
        onSelect={setActiveConvId}
        onNewChat={() => createConversation.mutate({})}
        isCreating={createConversation.isPending}
      />
      <ChatThread conversationId={activeConvId} />
    </div>
  )
}
