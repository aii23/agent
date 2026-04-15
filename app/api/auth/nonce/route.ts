import { generateNonce } from 'siwe'
import { storeNonce } from '@/lib/nonce-store'
import { NextResponse } from 'next/server'

export async function GET() {
  const nonce = generateNonce()
  storeNonce(nonce)
  return NextResponse.json({ nonce })
}
