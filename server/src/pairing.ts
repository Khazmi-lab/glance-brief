// Pairing-code flow (Google sign-in does not work inside the Even Hub WebView):
//  1. Glasses app: POST /pair/start -> { code: "ABCD-EF23", pollSecret, expiresAt }.
//     The code is shown on the glasses; the poll secret never leaves the app.
//  2. User opens <backend>/pair on a phone/laptop, types the code, and signs in with
//     Google (OAuth state is bound to the pairing record).
//  3. OAuth callback stores the tokens and approves the pairing.
//  4. Glasses app: POST /pair/poll { pollSecret } -> { status: "approved", deviceToken }
//     exactly once. The device token is stored server-side only as a SHA-256 hash.
import { newPairingCode, newSecret, normaliseCode, sha256 } from './crypto.ts'
import type { TokenStore } from './store.ts'

export const PAIRING_TTL_MS = 10 * 60_000

interface Pending {
  code: string
  pollHash: string
  expiresAt: number
  status: 'pending' | 'approved' | 'redeemed'
  state?: string
  accountId?: string
}

export type PollResult =
  | { status: 'pending'; expiresAt: number }
  | { status: 'approved'; deviceToken: string }
  | { status: 'expired' }

export class PairingService {
  private byCode = new Map<string, Pending>()
  private byPoll = new Map<string, Pending>()
  private byState = new Map<string, Pending>()
  private store: TokenStore
  private now: () => number
  private ttlMs: number
  constructor(store: TokenStore, now: () => number = Date.now, ttlMs = PAIRING_TTL_MS) {
    this.store = store; this.now = now; this.ttlMs = ttlMs
  }

  private sweep() {
    const t = this.now()
    for (const [k, p] of this.byCode) {
      if (p.expiresAt <= t) {
        this.byCode.delete(k); this.byPoll.delete(p.pollHash)
        if (p.state) this.byState.delete(p.state)
      }
    }
  }

  start(): { code: string; pollSecret: string; expiresAt: number } {
    this.sweep()
    let code = newPairingCode()
    while (this.byCode.has(code)) code = newPairingCode()
    const pollSecret = newSecret()
    const p: Pending = { code, pollHash: sha256(pollSecret), expiresAt: this.now() + this.ttlMs, status: 'pending' }
    this.byCode.set(code, p); this.byPoll.set(p.pollHash, p)
    return { code, pollSecret, expiresAt: p.expiresAt }
  }

  /** Step 2: a typed code is valid -> return an OAuth state bound to it (single use). */
  beginLogin(typed: string): string | null {
    this.sweep()
    const p = this.byCode.get(normaliseCode(typed))
    if (!p || p.status !== 'pending') return null
    if (p.state) this.byState.delete(p.state)
    p.state = newSecret(24)
    this.byState.set(p.state, p)
    return p.state
  }

  /** Step 3: OAuth callback. Returns false if the state is unknown/expired/used. */
  hasState(state: string): boolean {
    this.sweep()
    const p = this.byState.get(state)
    return !!p && p.status === 'pending'
  }

  approve(state: string, accountId: string): boolean {
    this.sweep()
    const p = this.byState.get(state)
    if (!p || p.status !== 'pending') return false
    this.byState.delete(state)
    p.status = 'approved'; p.accountId = accountId; p.state = undefined
    return true
  }

  /** Step 4: the device token is handed out once, then the pairing record is gone. */
  async poll(pollSecret: string): Promise<PollResult> {
    this.sweep()
    const p = this.byPoll.get(sha256(pollSecret))
    if (!p || p.status === 'redeemed') return { status: 'expired' }
    if (p.status === 'pending') return { status: 'pending', expiresAt: p.expiresAt }
    p.status = 'redeemed'
    this.byCode.delete(p.code); this.byPoll.delete(p.pollHash)
    const deviceToken = newSecret()
    await this.store.putDevice({ tokenHash: sha256(deviceToken), accountId: p.accountId!, createdAt: this.now() })
    return { status: 'approved', deviceToken }
  }
}

/** Fixed-window counter, e.g. failed code entries per IP. */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>()
  private max: number
  private windowMs: number
  private now: () => number
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max; this.windowMs = windowMs; this.now = now
  }
  allow(key: string): boolean {
    const t = this.now()
    const h = this.hits.get(key)
    if (!h || h.resetAt <= t) { this.hits.set(key, { n: 1, resetAt: t + this.windowMs }); return true }
    h.n++
    return h.n <= this.max
  }
}
