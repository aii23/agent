'use client'

import { useState } from 'react'
import { ListTree } from 'lucide-react'
import { ExecutionList } from '@/components/executions/execution-list'
import { ExecutionDetail } from '@/components/executions/execution-detail'

export default function ExecutionsPage() {
  const [activeId, setActiveId] = useState<string | null>(null)

  return (
    <div className="flex h-full overflow-hidden">
      <ExecutionList activeId={activeId} onSelect={setActiveId} />

      {activeId ? (
        <ExecutionDetail key={activeId} planId={activeId} />
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
        <ListTree className="w-5 h-5 text-zinc-500" />
      </div>
      <p className="text-sm text-zinc-500">Select an execution plan to inspect its steps.</p>
    </div>
  )
}
