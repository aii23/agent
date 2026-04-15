import { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    address?: string
    user: {
      address?: string
    } & DefaultSession['user']
  }
}
