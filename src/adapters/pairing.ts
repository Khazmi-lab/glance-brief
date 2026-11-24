// Glasses-side pairing client + device-token storage.
// The app shows a short code; the user signs in with Google on a phone at
// <backend>/pair; the app polls until the backend hands out a device token once.
import { fitPx, truncate } from '../core/text'

export interface PairingStart { code: string; pollSecret: string; expiresAt: number; loginPath: string }
export type PairingPoll = { status: 'pending' } | { status: 'approved'; deviceToken: string } | { status: 'expired' }

export class PairingClient {
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}
  async start(): Promise<PairingStart> {
    const r = await this.fetchImpl(`${this.baseUrl}/pair/start`, { method: 'POST', headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`pair/start -> HTTP ${r.status}`)
    return (await r.json()) as PairingStart
  }
  async poll(pollSecret: string): Promise<PairingPoll> {
    const r = await this.fetchImpl(`${this.baseUrl}/pair/poll`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }),
    })
    if (r.status === 410) return { status: 'expired' }
    if (!r.ok) throw new Error(`pair/poll -> HTTP ${r.status}`)
    return (await r.json()) as PairingPoll
  }
  async revoke(deviceToken: string): Promise<boolean> {
    const r = await this.fetchImpl(`${this.baseUrl}/pair/revoke`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}` } })
    return r.ok
  }
}

/** Minimal key/value store (localStorage in the WebView, a Map in tests). */
export interface KeyValue { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }
export const TOKEN_KEY = 'glance.deviceToken'
export function browserStorage(): KeyValue {
  return {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* storage unavailable: re-pair next launch */ } },
    remove: k => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
  }
}

/** Pairing screen, <= 6 lines that fit the 576 px display. */
export function pairingScreen(code: string, loginUrl: string, minutesLeft: number): string {
  const host = loginUrl.replace(/^https?:\/\//, '')
  return [
    'PAIR GLANCE BRIEF',
    'On your phone open:',
    fitPx(truncate(host, 40)),
    `Enter code  ${code}`,
    'Sign in with Google there.',
    `Code valid ${Math.max(0, Math.ceil(minutesLeft))} min · double tap exits`,
  ].join('\n')
}

export interface PairingDeps {
  client: PairingClient
  baseUrl: string
  show: (text: string) => Promise<void> | void
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Return true to stop (e.g. the user exited). */
  cancelled?: () => boolean
  pollMs?: number
  maxCodes?: number
}

/** Runs the pairing loop; resolves with a device token, or null if cancelled/gave up. */
export async function runPairing(d: PairingDeps): Promise<string | null> {
  const pollMs = d.pollMs ?? 3000
  for (let n = 0; n < (d.maxCodes ?? 3); n++) {
    const s = await d.client.start()
    const url = d.baseUrl + s.loginPath
    let shownMin = -1
    while (d.now() < s.expiresAt) {
      if (d.cancelled?.()) return null
      const min = Math.ceil((s.expiresAt - d.now()) / 60_000)
      if (min !== shownMin) { shownMin = min; await d.show(pairingScreen(s.code, url, min)) }
      let r: PairingPoll
      try { r = await d.client.poll(s.pollSecret) } catch { r = { status: 'pending' } }
      if (r.status === 'approved') return r.deviceToken
      if (r.status === 'expired') break
      await d.sleep(pollMs)
    }
  }
  await d.show('PAIR GLANCE BRIEF\nCode expired.\nReopen the app to get a new code.')
  return null
}
