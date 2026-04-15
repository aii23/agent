import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { SiweMessage } from 'siwe'
import { consumeNonce } from '@/lib/nonce-store'

const EXPECTED_DOMAIN = process.env.AUTH_DOMAIN ?? 'localhost:3001'

// Comma-separated list of checksummed addresses that may sign in.
// If empty / unset, ALL addresses are allowed.
const ALLOWED_ADDRESSES = (process.env.AUTH_ALLOWED_ADDRESSES ?? '')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean)

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        message: { label: 'Message', type: 'text' },
        signature: { label: 'Signature', type: 'text' },
      },
      async authorize(credentials) {
        try {
          const message = credentials?.message
          const signature = credentials?.signature
          if (
            !message ||
            !signature ||
            typeof message !== 'string' ||
            typeof signature !== 'string'
          ) {
            return null
          }

          const siwe = new SiweMessage(JSON.parse(message))

          // Reject messages crafted for a different domain (anti-phishing)
          if (siwe.domain !== EXPECTED_DOMAIN) return null

          // Wallet allowlist (when configured)
          if (
            ALLOWED_ADDRESSES.length > 0 &&
            !ALLOWED_ADDRESSES.includes(siwe.address.toLowerCase())
          ) {
            return null
          }

          // Single-use nonce — prevents replay attacks
          if (!consumeNonce(siwe.nonce)) return null

          // Cryptographic verification + timestamp checks
          const { success } = await siwe.verify({
            signature,
            domain: EXPECTED_DOMAIN,
            nonce: siwe.nonce,
          })
          if (!success) return null

          return { id: siwe.address, name: siwe.address }
        } catch {
          return null
        }
      },
    }),
  ],

  session: { strategy: 'jwt' },

  pages: { signIn: '/login' },

  callbacks: {
    async session({ session, token }) {
      return {
        ...session,
        address: token.sub,
        user: { ...session.user, address: token.sub },
      }
    },
  },
})
