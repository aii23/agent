'use client'

import { usePathname } from 'next/navigation'
import { ChevronRight, Wallet, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useSession, signOut } from 'next-auth/react'

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

  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: session } = useSession()

  const handleConnect = () => {
    const injected = connectors.find((c) => c.type === 'injected')
    if (injected) connect({ connector: injected })
  }

  const handleSignOut = async () => {
    disconnect()
    await signOut({ callbackUrl: '/login' })
  }

  const sessionAddress = (session?.user?.address ?? session?.address) as string | undefined
  const displayAddress = address ?? sessionAddress

  return (
    <header className="h-12 shrink-0 border-b border-zinc-800 flex items-center justify-between px-5 bg-zinc-950">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-500">Praxis</span>
        <ChevronRight className="w-3 h-3 text-zinc-700" />
        <span className="text-sm font-medium text-zinc-200">{pageName}</span>
      </div>

      {/* Wallet / Auth */}
      {session && displayAddress ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-400 bg-zinc-800/60 border border-zinc-700 px-2.5 py-1 rounded">
            {displayAddress.slice(0, 6)}…{displayAddress.slice(-4)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
            onClick={handleSignOut}
          >
            <LogOut className="w-3 h-3" />
            Sign out
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1.5 border-zinc-700 bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 hover:border-zinc-600"
          onClick={isConnected ? undefined : handleConnect}
        >
          <Wallet className="w-3 h-3" />
          {isConnected ? `${address?.slice(0, 6)}…${address?.slice(-4)}` : 'Connect Wallet'}
        </Button>
      )}
    </header>
  )
}
