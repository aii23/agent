import { Sidebar } from '@/components/sidebar'
import { TopBar } from '@/components/top-bar'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="h-screen overflow-hidden bg-zinc-950">
      <Sidebar />
      <div className="ml-16 lg:ml-60 h-screen flex flex-col">
        <TopBar />
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
