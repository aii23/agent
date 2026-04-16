'use client'

import { useState, type ReactNode } from 'react'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { mainnet, base, polygon, optimism, arbitrum, sepolia } from 'viem/chains'
import { httpBatchLink } from '@trpc/client'
import { trpc } from '@/lib/trpc'

const wagmiConfig = createConfig({
  chains: [mainnet, base, polygon, optimism, arbitrum, sepolia],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [polygon.id]: http(),
    [optimism.id]: http(),
    [arbitrum.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: true,
})

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
}

let browserQueryClient: QueryClient | undefined

function getQueryClient() {
  if (typeof window === 'undefined') return makeQueryClient()
  if (!browserQueryClient) browserQueryClient = makeQueryClient()
  return browserQueryClient
}

function getBaseUrl() {
  if (typeof window !== 'undefined') return ''
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return `http://localhost:${process.env.PORT ?? 3000}`
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient()
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({ url: `${getBaseUrl()}/api/trpc` }),
      ],
    })
  )

  return (
    <SessionProvider>
      <WagmiProvider config={wagmiConfig}>
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </trpc.Provider>
      </WagmiProvider>
    </SessionProvider>
  )
}
