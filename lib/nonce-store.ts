/**
 * In-memory single-use nonce store for SIWE authentication.
 *
 * Each nonce expires after 5 minutes. Once consumed it cannot be reused.
 * For multi-replica deployments, swap for Redis SET key value EX 300 NX.
 */

const store = new Map<string, number>()
const TTL_MS = 5 * 60 * 1000

export function storeNonce(nonce: string): void {
  store.set(nonce, Date.now() + TTL_MS)
}

export function consumeNonce(nonce: string): boolean {
  const expiry = store.get(nonce)
  if (expiry === undefined) return false
  store.delete(nonce)
  return Date.now() <= expiry
}
