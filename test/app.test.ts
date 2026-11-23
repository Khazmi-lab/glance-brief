import { describe, expect, it } from 'vitest'
import { GlanceApp } from '../src/app'
import { DemoCalendar, DemoMail } from '../src/adapters/demo'
import { HeuristicSummarizer } from '../src/adapters/llm'
import type { ReplySink } from '../src/core/types'
import { readConfig } from '../src/config'
import { expectFits } from './helpers'

const now = new Date('2026-11-23T13:20:00Z')
function setup() {
  const shown: string[] = []
  const saved: { to: string; body: string }[] = []
  let exited = 0
  const sink: ReplySink = { saveReply: async (to, body) => { saved.push({ to: to.fromAddress, body }); return { ok: true, detail: 'saved' } } }
  const app = new GlanceApp({
    calendar: new DemoCalendar(now), mail: new DemoMail(now), summarizer: new HeuristicSummarizer(), sink,
    display: { show: t => { shown.push(t) }, exit: () => { exited++ } },
    now: () => now, timeZone: 'Europe/Rome', demo: true,
  })
  return { app, shown, saved, exited: () => exited }
}

describe('GlanceApp end-to-end with demo data (test data)', () => {
  it('loads, navigates, drafts, confirms and saves exactly once', async () => {
    const t = setup()
    await t.app.load()
    expect(t.shown[0].split('\n')[0]).toBe('NEXT MEETING · DEMO 14:20')
    expect(t.shown[0]).toContain('in 12 min')
    await t.app.dispatch({ type: 'click' }) // -> first email
    expect(t.shown.at(-1)).toContain('Sara (demo)')
    await t.app.dispatch({ type: 'click' }) // -> draft
    expect(t.shown.at(-1)).toMatch(/^REPLY TO Sara/)
    expect(t.saved).toHaveLength(0)
    await t.app.dispatch({ type: 'click' }) // confirm
    expect(t.saved).toEqual([{ to: 'sara@example.com', body: 'Thanks Sara, got it. I will get back to you today.' }])
    expect(t.shown.at(-1)).toMatch(/^DONE/)
    for (const s of t.shown) expectFits(s)
  })
  it('double tap exits', async () => {
    const t = setup()
    await t.app.load()
    await t.app.dispatch({ type: 'double_click' })
    expect(t.exited()).toBe(1)
  })
})

describe('config', () => {
  it('defaults to DEMO mode without a backend', () => {
    expect(readConfig('', 'Europe/Rome')).toMatchObject({ demo: true, timeZone: 'Europe/Rome' })
  })
  it('accepts https or localhost backends only', () => {
    expect(readConfig('?backend=https://api.example.com/&pair=abc&model=m', 'UTC')).toMatchObject({ demo: false, backend: 'https://api.example.com', pairingToken: 'abc', model: 'm' })
    expect(readConfig('?backend=http://evil.example.com', 'UTC').demo).toBe(true)
    expect(readConfig('?backend=http://localhost:8787', 'UTC').demo).toBe(false)
  })
})
