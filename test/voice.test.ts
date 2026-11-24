// Voice reply: buffer, event mapping, state machine and app wiring (fake mic + fake STT).
import { describe, expect, it } from 'vitest'
import { GlanceApp } from '../src/app'
import { DemoCalendar, DemoMail } from '../src/adapters/demo'
import { HeuristicSummarizer, tidyDictation } from '../src/adapters/llm'
import { DEMO_TRANSCRIPT, DemoStt } from '../src/adapters/stt'
import type { Page } from '../src/core/brief'
import { mapEvent } from '../src/core/events'
import { initialState, reduce, render, type Input, type State } from '../src/core/state'
import type { Mic, ReplySink, SpeechToText } from '../src/core/types'
import { MAX_BYTES, MIN_BYTES, VoiceBuffer, bytesToBase64, toBytes } from '../src/core/voice'
import { expectFits } from './helpers'

const frame = (n = 3200, v = 1) => new Uint8Array(n).fill(v)

describe('VoiceBuffer', () => {
  it('collects frames only while recording and returns them in order', () => {
    const b = new VoiceBuffer()
    expect(b.push(frame(10))).toBe(false)
    expect(b.bytes).toBe(0)
    b.start(); b.push(frame(4, 1)); b.push(frame(4, 2))
    expect(Array.from(b.stop())).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    expect(b.recording).toBe(false)
    expect(b.bytes).toBe(0)
  })
  it('caps at 15 s and reports full; trims to whole samples', () => {
    const b = new VoiceBuffer(); b.start()
    let full = false
    for (let i = 0; i < 200 && !full; i++) full = b.push(frame())
    expect(full).toBe(true)
    expect(b.bytes).toBe(MAX_BYTES)
    expect(b.seconds).toBe(15)
    b.discard(); b.start(); b.push(frame(5))
    expect(b.stop().length).toBe(4)
  })
  it('discard drops audio', () => {
    const b = new VoiceBuffer(); b.start(); b.push(frame()); b.discard()
    expect(b.bytes).toBe(0); expect(b.recording).toBe(false)
  })
  it('accepts Uint8Array, number[] and base64 frames from the host', () => {
    expect(Array.from(toBytes(new Uint8Array([1, 2])))).toEqual([1, 2])
    expect(Array.from(toBytes([1, 2, 258]))).toEqual([1, 2, 2])
    expect(Array.from(toBytes(btoa('\x01\x02')))).toEqual([1, 2])
    expect(toBytes(undefined).length).toBe(0)
  })
  it('base64-encodes large buffers', () => {
    const big = frame(MAX_BYTES, 7)
    const s = bytesToBase64(big)
    expect(Buffer.from(s, 'base64').equals(Buffer.from(big))).toBe(true)
  })
})

describe('event mapping', () => {
  it('maps long press and its release', () => {
    expect(mapEvent({ sysEvent: { eventType: 9 } })).toEqual({ type: 'long_press' })
    expect(mapEvent({ textEvent: { eventType: 10 } })).toEqual({ type: 'long_press_release' })
    expect(mapEvent({ sysEvent: { eventType: '10' } })).toEqual({ type: 'long_press_release' }) // numeric string from some hosts
  })
})

const pages: Page[] = [
  { kind: 'meeting', lines: ['NEXT MEETING', 'Planning'] },
  { kind: 'email', emailIndex: 0, lines: ['INBOX 1/2', 'Giulia Bianchi', 'Budget'] },
  { kind: 'email', emailIndex: 1, lines: ['INBOX 2/2', 'Shipping', 'Order'] },
]
const run = (s: State, ...inputs: Input[]) => {
  const effects: any[] = []
  for (const i of inputs) { const r = reduce(s, i); s = r.state; effects.push(...r.effects) }
  return { s, effects }
}
const onEmail = { ...initialState(pages), index: 1 }

describe('voice state machine', () => {
  it('long press on the meeting card does nothing', () => {
    expect(run(initialState(pages), { type: 'long_press' })).toMatchObject({ s: { mode: 'browse' }, effects: [] })
  })
  it('hold -> release -> transcript -> draft -> confirm; writes only on the confirm tap', () => {
    let r = run(onEmail, { type: 'long_press' })
    expect(r.s.mode).toBe('listening')
    expect(r.effects).toEqual([{ type: 'start_mic' }])
    expect(render(r.s)).toContain('LISTENING')
    r = run(r.s, { type: 'click' }) // stray tap while listening is ignored
    expect(r).toMatchObject({ s: { mode: 'listening' }, effects: [] })
    r = run(r.s, { type: 'long_press_release' })
    expect(r.s.mode).toBe('transcribing')
    expect(r.effects).toEqual([{ type: 'stop_mic', transcribe: true, emailIndex: 0 }])
    r = run(r.s, { type: 'voice_text', text: ' yes, send numbers friday ' })
    expect(r.s).toMatchObject({ mode: 'drafting', heard: 'yes, send numbers friday' })
    expect(r.effects).toEqual([{ type: 'polish_reply', emailIndex: 0, said: 'yes, send numbers friday' }])
    expect(render(r.s)).toContain('Heard: yes, send numbers friday')
    r = run(r.s, { type: 'draft_ready', body: 'Yes, I will send the numbers on Friday.' })
    expect(r.s.mode).toBe('confirm')
    expect(r.effects).toEqual([])
    expect(render(r.s)).toContain('Tap: SAVE as Gmail draft')
    r = run(r.s, { type: 'click' })
    expect(r.effects).toEqual([{ type: 'save_reply', emailIndex: 0, body: 'Yes, I will send the numbers on Friday.' }])
  })
  it('the length cap acts like a release', () => {
    const r = run(onEmail, { type: 'long_press' }, { type: 'voice_limit' })
    expect(r.s.mode).toBe('transcribing')
    expect(r.effects.at(-1)).toEqual({ type: 'stop_mic', transcribe: true, emailIndex: 0 })
  })
  it('swipe while listening closes the mic and discards audio', () => {
    const r = run(onEmail, { type: 'long_press' }, { type: 'down' })
    expect(r.s).toMatchObject({ mode: 'browse', index: 1 })
    expect(r.effects.at(-1)).toEqual({ type: 'stop_mic', transcribe: false })
  })
  it('double tap while listening closes the mic, then exits', () => {
    const r = run(onEmail, { type: 'long_press' }, { type: 'double_click' })
    expect(r.effects.slice(1)).toEqual([{ type: 'stop_mic', transcribe: false }, { type: 'exit' }])
  })
  it('empty transcript, STT failure and mic failure are shown', () => {
    const base = run(onEmail, { type: 'long_press' }, { type: 'long_press_release' }).s
    expect(render(run(base, { type: 'voice_text', text: '  ' }).s)).toContain("Didn't catch that")
    expect(render(run(base, { type: 'voice_failed', reason: 'HTTP 503' }).s)).toContain('Voice failed: HTTP 503')
    expect(render(run(onEmail, { type: 'long_press' }, { type: 'mic_failed', reason: 'no mic' }).s)).toContain('Mic unavailable: no mic')
  })
  it('swipe while transcribing cancels; a late transcript is ignored', () => {
    const r = run(onEmail, { type: 'long_press' }, { type: 'long_press_release' }, { type: 'up' }, { type: 'voice_text', text: 'late' })
    expect(r.s.mode).toBe('browse')
    expect(r.effects.filter(e => e.type === 'polish_reply' || e.type === 'save_reply')).toEqual([])
  })
  it('long press on the confirm screen re-dictates (old draft dropped)', () => {
    const r = run({ ...onEmail, mode: 'confirm', draft: 'old' }, { type: 'long_press' })
    expect(r.s).toMatchObject({ mode: 'listening', draft: undefined })
    expect(r.effects).toEqual([{ type: 'start_mic' }])
  })
  it('voice screens fit 6 lines x 40 chars', () => {
    const long = 'word '.repeat(80)
    for (const s of [
      { ...onEmail, mode: 'listening' as const },
      { ...onEmail, mode: 'transcribing' as const },
      { ...onEmail, mode: 'drafting' as const, heard: long },
      { ...onEmail, mode: 'confirm' as const, draft: long },
    ]) expectFits(render(s))
  })
})

describe('tidyDictation (offline polish adds no words)', () => {
  it('capitalises and punctuates', () => {
    expect(tidyDictation('yes friday works')).toBe('Yes friday works.')
    expect(tidyDictation('ok!')).toBe('Ok!')
    expect(tidyDictation('   ')).toBe('')
    expect(tidyDictation('a '.repeat(60)).split(' ').length).toBeLessThanOrEqual(41)
  })
})

const now = new Date('2026-11-23T13:20:00Z')
function setup(o: { stt?: SpeechToText | null; micOk?: boolean } = {}) {
  const shown: string[] = []
  const saved: { to: string; body: string }[] = []
  const micLog: string[] = []
  const heard: Uint8Array[] = []
  const sink: ReplySink = { saveReply: async (to, body) => { saved.push({ to: to.fromAddress, body }); return { ok: true, detail: 'saved' } } }
  const mic: Mic = { open: async () => { micLog.push('open'); return o.micOk ?? true }, close: async () => { micLog.push('close') } }
  const stt: SpeechToText = { transcribe: async pcm => { heard.push(pcm); return 'yes I will check slide four before three thirty' } }
  const app = new GlanceApp({
    calendar: new DemoCalendar(now), mail: new DemoMail(now), summarizer: new HeuristicSummarizer(), sink,
    display: { show: t => { shown.push(t) }, exit: () => {} }, now: () => now, timeZone: 'Europe/Rome', demo: true,
    mic, stt: o.stt === null ? undefined : (o.stt ?? stt),
  })
  return { app, shown, saved, micLog, heard }
}

describe('GlanceApp voice reply (fake mic + fake STT; demo data)', () => {
  it('records frames between press and release, transcribes, drafts, saves only after the tap', async () => {
    const t = setup()
    await t.app.load()
    await t.app.dispatch({ type: 'click' }) // -> first email
    await t.app.dispatch({ type: 'long_press' })
    expect(t.micLog).toEqual(['open'])
    expect(t.shown.at(-1)).toMatch(/^LISTENING/)
    for (let i = 0; i < 12; i++) t.app.pushAudio(frame(3200, i))
    await t.app.dispatch({ type: 'long_press_release' })
    expect(t.micLog).toEqual(['open', 'close'])
    expect(t.heard).toHaveLength(1)
    expect(t.heard[0].length).toBe(12 * 3200)
    expect(t.heard[0][3200]).toBe(1)
    expect(t.shown.at(-1)).toMatch(/^REPLY TO Sara/)
    expect(t.shown.at(-1)).toContain('Yes I will check slide four')
    expect(t.saved).toHaveLength(0)
    t.app.pushAudio(frame()) // frames after release are ignored
    expect(t.app.voice.bytes).toBe(0)
    await t.app.dispatch({ type: 'click' })
    expect(t.saved).toEqual([{ to: 'sara@example.com', body: 'Yes I will check slide four before three thirty.' }])
    t.shown.forEach(expectFits)
  })
  it('stops by itself at 15 s', async () => {
    const t = setup()
    await t.app.load()
    await t.app.dispatch({ type: 'click' })
    await t.app.dispatch({ type: 'long_press' })
    for (let i = 0; i < 160; i++) t.app.pushAudio(frame())
    await t.app.dispatch({ type: 'long_press_release' }) // arrives after the cap: ignored by then
    expect(t.heard).toHaveLength(1)
    expect(t.heard[0].length).toBe(MAX_BYTES)
    expect(t.micLog).toEqual(['open', 'close'])
  })
  it('a too-short press is refused without calling STT', async () => {
    const t = setup()
    await t.app.load()
    await t.app.dispatch({ type: 'click' })
    await t.app.dispatch({ type: 'long_press' })
    t.app.pushAudio(frame(MIN_BYTES - 2))
    await t.app.dispatch({ type: 'long_press_release' })
    expect(t.heard).toHaveLength(0)
    expect(t.shown.at(-1)).toContain('too short')
  })
  it('mic that fails to open or missing STT is reported, nothing recorded', async () => {
    for (const t of [setup({ micOk: false }), setup({ stt: null })]) {
      await t.app.load()
      await t.app.dispatch({ type: 'click' })
      await t.app.dispatch({ type: 'long_press' })
      expect(t.shown.at(-1)).toContain('Mic unavailable')
      expect(t.app.voice.recording).toBe(false)
    }
  })
  it('STT errors are shown, not hidden', async () => {
    const t = setup({ stt: { transcribe: async () => { throw new Error('POST /stt/v1/transcribe -> HTTP 503') } } })
    await t.app.load()
    await t.app.dispatch({ type: 'click' })
    await t.app.dispatch({ type: 'long_press' })
    for (let i = 0; i < 5; i++) t.app.pushAudio(frame())
    await t.app.dispatch({ type: 'long_press_release' })
    expect(t.shown.at(-1)).toContain('Voice failed')
    expect(t.saved).toHaveLength(0)
  })
  it('DemoStt is labelled demo', async () => {
    expect(await new DemoStt().transcribe()).toBe(DEMO_TRANSCRIPT)
    expect(DEMO_TRANSCRIPT).toMatch(/^demo/)
  })
})
