'use client'

import { usePathname } from 'next/navigation'
import { ChevronRight, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'

const PAGE_NAMES: Record<string, string> = {
  '/chat': 'Chat',
  '/workflows': 'Workflows',
  '/runs': 'Runs',
  '/agents': 'Agents',
  '/settings': 'Settings',
}

export function TopBar() {
  const pathname = usePathname()
  const pageName =
    Object.entries(PAGE_NAMES).find(([key]) => pathname.startsWith(key))?.[1] ??
    'Dashboard'

  return (
    <header className="h-12 shrink-0 border-b border-zinc-800 flex items-center justify-between px-5 bg-zinc-950">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-500">Praxis</span>
        <ChevronRight className="w-3 h-3 text-zinc-700" />
        <span className="text-sm font-medium text-zinc-200">{pageName}</span>
      </div>

      {/* Connect Wallet */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1.5 border-zinc-700 bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 hover:border-zinc-600"
      >
        <Wallet className="w-3 h-3" />
        Connect Wallet
      </Button>
    </header>
  )
}
