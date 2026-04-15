'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MessageSquare, GitBranch, Activity, Bot, Settings, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'

const navItems = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/workflows', label: 'Workflows', icon: GitBranch },
  { href: '/runs', label: 'Runs', icon: Activity },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const [hovering, setHovering] = useState(false)

  return (
    <aside className="fixed left-0 top-0 h-screen w-16 lg:w-60 bg-zinc-900 border-r border-zinc-800 flex flex-col z-50 transition-all duration-200">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-zinc-800 shrink-0">
        <div className="shrink-0 w-7 h-7 bg-indigo-600 rounded flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-white">
            <path d="M12 2L20.785 7.5V16.5L12 22L3.215 16.5V7.5L12 2Z" />
          </svg>
        </div>
        <span className="hidden lg:block font-semibold text-zinc-100 tracking-tight text-base">
          Praxis
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150',
                isActive
                  ? 'text-zinc-100 bg-zinc-800'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
              )}
            >
              {isActive && (
                <span className="absolute left-0 inset-y-[6px] w-0.5 bg-indigo-500 rounded-r" />
              )}
              <Icon
                className={cn(
                  'w-4 h-4 shrink-0',
                  isActive ? 'text-indigo-400' : ''
                )}
              />
              <span className="hidden lg:block">{label}</span>
            </Link>
          )
        })}
      </nav>

      {/* User section */}
      <div className="p-2 border-t border-zinc-800 shrink-0">
        <div
          className="relative flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-zinc-800/60 transition-colors"
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          {/* Avatar */}
          <div className="relative shrink-0">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-[10px] font-bold text-white">
              0x
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-zinc-900" />
          </div>
          {/* Address */}
          <div className="hidden lg:block min-w-0 flex-1">
            <p className="text-xs text-zinc-300 font-mono truncate">0x7a3F...c91E</p>
          </div>
          {/* Disconnect on hover */}
          {hovering && (
            <button className="hidden lg:flex items-center gap-1 text-xs text-red-400 hover:text-red-300 shrink-0 transition-colors">
              <LogOut className="w-3 h-3" />
              <span>Out</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
