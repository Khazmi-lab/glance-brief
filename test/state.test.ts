import { describe, expect, it } from 'vitest'
import type { Page } from '../src/core/brief'
import { initialState, reduce, render, type Input, type State } from '../src/core/state'
import { expectFits } from './helpers'

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

describe('state machine', () => {
  it('scrolls through pages and clamps at the ends', () => {
    const { s } = run(initialState(pages), { type: 'down' }, { type: 'down' }, { type: 'down' })
    expect(s.index).toBe(2)
    expect(run(s, { type: 'up' }, { type: 'up' }, { type: 'up' }).s.index).toBe(0)
  })
  it('tap on the meeting card jumps to the inbox', () => {
    expect(run(initialState(pages), { type: 'click' }).s.index).toBe(1)
  })
  it('double tap exits from every mode', () => {
    const modes: State[] = [
      initialState(pages),
      { ...initialState(pages), index: 1, mode: 'drafting' },
      { ...initialState(pages), index: 1, mode: 'confirm', draft: 'x' },
      { ...initialState(pages), index: 1, mode: 'saving', draft: 'x' },
      { ...initialState(pages), index: 1, mode: 'result', resultText: 'ok' },
    ]
    for (const m of modes) expect(reduce(m, { type: 'double_click' }).effects).toEqual([{ type: 'exit' }])
  })
  it('write only after an explicit confirm tap', () => {
    let r = run(initialState(pages), { type: 'down' }, { type: 'click' })
    expect(r.effects).toEqual([{ type: 'request_draft', emailIndex: 0 }])
    expect(r.s.mode).toBe('drafting')
    r = run(r.s, { type: 'draft_ready', body: 'Sure, by 15:30.' })
    expect(r.s.mode).toBe('confirm')
    expect(r.effects).toEqual([])
    expect(render(r.s)).toContain('Tap: SAVE as Gmail draft')
    r = run(r.s, { type: 'click' })
    expect(r.effects).toEqual([{ type: 'save_reply', emailIndex: 0, body: 'Sure, by 15:30.' }])
    r = run(r.s, { type: 'click' }, { type: 'click' })
    expect(r.effects).toEqual([]) // repeated taps while saving don't double-save
    r = run(r.s, { type: 'save_done', ok: true, detail: 'Draft saved' })
    expect(r.s.mode).toBe('result')
    expect(run(r.s, { type: 'click' }).s).toMatchObject({ mode: 'browse', index: 2 })
  })
  it('swipe cancels a draft without writing', () => {
    const r = run(initialState(pages), { type: 'down' }, { type: 'click' }, { type: 'draft_ready', body: 'x' }, { type: 'down' })
    expect(r.s.mode).toBe('browse')
    expect(r.effects.filter(e => e.type === 'save_reply')).toEqual([])
  })
  it('draft failure is shown, not swallowed', () => {
    const r = run(initialState(pages), { type: 'down' }, { type: 'click' }, { type: 'draft_failed', reason: 'LLM 500' })
    expect(render(r.s)).toContain('Draft failed: LLM 500')
  })
  it('every screen renders within 6 lines x 40 chars', () => {
    const long = 'word '.repeat(80)
    const states: State[] = [
      initialState(pages),
      { ...initialState(pages), index: 1, mode: 'drafting' },
      { ...initialState(pages), index: 1, mode: 'confirm', draft: long },
      { ...initialState(pages), index: 1, mode: 'saving' },
      { ...initialState(pages), index: 1, mode: 'result', resultText: long },
      initialState([]),
    ]
    for (const s of states) expectFits(render(s))
  })
})
