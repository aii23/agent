'use client'

import { useState } from 'react'
import { ConversationList } from '@/components/chat/conversation-list'
import { ChatThread } from '@/components/chat/chat-thread'

export default function ChatPage() {
  const [activeConvId, setActiveConvId] = useState(1)

  return (
    <div className="flex h-full overflow-hidden">
      <ConversationList activeId={activeConvId} onSelect={setActiveConvId} />
      <ChatThread />
    </div>
  )
}
