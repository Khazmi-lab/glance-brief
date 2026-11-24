// End to end: the real glasses-app adapters talk over real HTTP to the real backend,
// which talks to FAKE Google/LLM upstreams (test doubles; synthetic fixtures).
import { afterEach, describe, expect, it } from 'vitest'
import { GlanceApp } from '../src/app'
import { GmailDraftSink, GmailSource } from '../src/adapters/gmail'
import { GoogleCalendarSource } from '../src/adapters/google-calendar'
import { FetchHttpClient } from '../src/adapters/http'
import { FallbackSummarizer, HeuristicSummarizer, LlmSummarizer } from '../src/adapters/llm'
import { PairingClient, pairingScreen, runPairing } from '../src/adapters/pairing'
import { BackendStt } from '../src/adapters/stt'
import { approveOnPhone, boot, pairDevice } from '../server/test/harness'
import { expectFits } from './helpers'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

describe('pairing screen', () => {
  it('fits the display', () => {
    const t = pairingScreen('ABCD-EF23', 'https://glance-brief.example.com/pair', 9.2)
    expectFits(t)
    expect(t).toContain('ABCD-EF23')
    expect(t).toContain('Code valid 10 min')
    expectFits(pairingScreen('ABCD-EF23', 'https://a-very-long-subdomain.backend-host.example.com/pair', 1))
  })
})

describe('glasses app <-> backend <-> Google (mocked)', () => {
  it('pairs via runPairing, then loads a real-path brief, drafts with the LLM and saves a Gmail draft', async () => {
    const b = await boot({ llmReply: 'Thanks Anna, numbers coming before 16:00.' })
    close = b.close
    const screens: string[] = []
    let polls = 0
    const client = new PairingClient(b.base)
    // The "user" approves on the phone after the app has polled twice.
    const token = await runPairing({
      client, baseUrl: b.base, now: () => Date.now(), pollMs: 1,
      show: t => { screens.push(t) },
      sleep: async () => { if (++polls === 2) { const code = /code {2}(\S+)/.exec(screens[0])![1]; await approveOnPhone(b.base, code) } },
    })
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(screens[0]).toContain(`${b.base.replace('http://', '')}/pair`)
    screens.forEach(expectFits)

    let unauthorized = 0
    const http = new FetchHttpClient(b.base, token!, undefined, () => unauthorized++)
    const shown: string[] = []
    const app = new GlanceApp({
      calendar: new GoogleCalendarSource(http), mail: new GmailSource(http),
      summarizer: new FallbackSummarizer(new LlmSummarizer(http, 'test-model'), new HeuristicSummarizer()),
      sink: new GmailDraftSink(http), display: { show: t => { shown.push(t) }, exit: () => {} },
      now: () => new Date('2026-11-23T13:20:00Z'), timeZone: 'Europe/Rome', demo: false,
    })
    await app.load()
    shown.forEach(expectFits)
    expect(shown[0]).not.toContain('DEMO')
    expect(shown[0]).not.toMatch(/HTTP \d{3}/)
    // Walk to the first email, request a draft, confirm.
    await app.dispatch({ type: 'click' })
    await app.dispatch({ type: 'click' })
    expect(shown.at(-1)).toContain('Thanks Anna')
    const draftsBefore = b.up.calls.filter(c => c.url.endsWith('/drafts')).length
    expect(draftsBefore).toBe(0) // nothing written before the confirm tap
    await app.dispatch({ type: 'click' })
    expect(shown.at(-1)).toContain('Draft saved in Gmail (not sent)')
    const drafts = b.up.calls.filter(c => c.url.endsWith('/drafts'))
    expect(drafts).toHaveLength(1)
    expect(b.up.calls.some(c => /\/send\b/.test(c.url))).toBe(false)
    // Every Google call carried the server-held access token; the app never had it.
    for (const c of b.up.calls.filter(c => c.url.includes('googleapis.com/') && !c.url.includes('/token'))) expect(c.auth).toBe('Bearer access-1')
    expect(unauthorized).toBe(0)

    // Revoking the device makes the next call 401 -> app callback fires (forget token, re-pair).
    expect(await client.revoke(token!)).toBe(true)
    await expect(new GmailSource(http).unread(1)).rejects.toThrow(/HTTP 401/)
    expect(unauthorized).toBe(1)
  })

  it('runPairing gives up after maxCodes expired codes and says so on screen', async () => {
    let t = 0
    const shown: string[] = []
    const fake = {
      start: async () => ({ code: 'ABCD-EF23', pollSecret: 'p', expiresAt: t + 2000, loginPath: '/pair' }),
      poll: async () => ({ status: 'pending' as const }),
    } as unknown as PairingClient
    const r = await runPairing({ client: fake, baseUrl: 'https://b.example', show: s => { shown.push(s) }, now: () => t, sleep: async ms => { t += ms }, pollMs: 1000, maxCodes: 2 })
    expect(r).toBeNull()
    expect(shown.at(-1)).toContain('Code expired')
    shown.forEach(expectFits)
  })

  it('runPairing stops when cancelled (double tap during pairing)', async () => {
    const fake = { start: async () => ({ code: 'ABCD-EF23', pollSecret: 'p', expiresAt: Date.now() + 60_000, loginPath: '/pair' }), poll: async () => ({ status: 'pending' as const }) } as unknown as PairingClient
    let n = 0
    const r = await runPairing({ client: fake, baseUrl: 'https://b.example', show: () => {}, now: () => Date.now(), sleep: async () => { n++ }, cancelled: () => n >= 3 })
    expect(r).toBeNull()
    expect(n).toBe(3)
  })

  it('without an LLM on the backend, summaries fall back to the offline heuristic', async () => {
    const b = await boot({ llm: false })
    close = b.close
    const s = await (await fetch(`${b.base}/pair/start`, { method: 'POST' })).json() as any
    await approveOnPhone(b.base, s.code)
    const { deviceToken } = await (await fetch(`${b.base}/pair/poll`, { method: 'POST', body: JSON.stringify({ pollSecret: s.pollSecret }) })).json() as any
    const http = new FetchHttpClient(b.base, deviceToken)
    const mail = await new GmailSource(http).unread(2)
    const sum = new FallbackSummarizer(new LlmSummarizer(http, 'test-model'), new HeuristicSummarizer())
    expect(await sum.emailSummary(mail[0], 12)).toBe(await new HeuristicSummarizer().emailSummary(mail[0], 12))
  })

  it('voice reply end to end: hold -> PCM -> backend STT -> LLM polish -> confirm -> one Gmail draft, never sent', async () => {
    const b = await boot({ sttText: 'yes the budget numbers are coming before four', llmReply: 'Yes, the budget numbers are coming before 16:00.' })
    close = b.close
    const token = await pairDevice(b.base)
    const http = new FetchHttpClient(b.base, token)
    const shown: string[] = []
    const mic = { log: [] as string[], open: async () => { mic.log.push('open'); return true }, close: async () => { mic.log.push('close') } }
    const app = new GlanceApp({
      calendar: new GoogleCalendarSource(http), mail: new GmailSource(http),
      summarizer: new FallbackSummarizer(new LlmSummarizer(http, 'test-model'), new HeuristicSummarizer()),
      sink: new GmailDraftSink(http), display: { show: t => { shown.push(t) }, exit: () => {} },
      now: () => new Date('2026-11-23T13:20:00Z'), timeZone: 'Europe/Rome', demo: false,
      mic, stt: new BackendStt(http),
    })
    await app.load()
    await app.dispatch({ type: 'click' }) // first email
    await app.dispatch({ type: 'long_press' })
    for (let i = 0; i < 20; i++) app.pushAudio(Array.from(new Uint8Array(3200).fill(i))) // number[] frames, as some hosts send
    await app.dispatch({ type: 'long_press_release' })
    expect(mic.log).toEqual(['open', 'close'])
    const sttCall = b.up.calls.find(c => c.url.includes('stt.test'))!
    expect(sttCall.form!.wav!.length).toBe(44 + 20 * 3200)
    const llmCall = b.up.calls.filter(c => c.url.includes('llm.test')).at(-1)!
    expect(llmCall.body).toContain('I said: yes the budget numbers are coming before four')
    expect(shown.at(-1)).toContain('Yes, the budget numbers are coming')
    expect(b.up.calls.filter(c => c.url.endsWith('/drafts'))).toHaveLength(0)
    await app.dispatch({ type: 'click' })
    expect(shown.at(-1)).toContain('Draft saved in Gmail (not sent)')
    expect(b.up.calls.filter(c => c.url.endsWith('/drafts'))).toHaveLength(1)
    expect(b.up.calls.some(c => /\/send\b/.test(c.url))).toBe(false)
    expect(b.logs.join('\n')).not.toMatch(/budget numbers/)
    shown.forEach(expectFits)
  })
})
