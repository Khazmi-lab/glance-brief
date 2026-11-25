// v0.4 pure logic: back-to-back focus, meeting-context query + offline pending items, drafts moment.
import { describe, expect, it } from 'vitest'
import { contextQuery, draftMoment, heuristicPending, pickFocus, staleDrafts } from '../src/core/context'
import { demoEmails, demoHistory, demoMeetings } from '../src/adapters/demo'
import type { EmailItem, Meeting, PendingDraft } from '../src/core/types'

const now = new Date('2026-11-23T13:20:00Z')
const H = 12 * 3600000
const at = (min: number) => new Date(now.getTime() + min * 60000)
const mtg = (id: string, s: number, e: number): Meeting => ({ id, title: id, start: at(s), end: at(e), attendees: [] })
const mail = (from: string, addr: string, snippet: string, minAgo: number): EmailItem =>
  ({ id: addr + minAgo, threadId: 't', from, fromAddress: addr, subject: 's', snippet, receivedAt: at(-minAgo) })

describe('pickFocus / back-to-back', () => {
  it('in a meeting with the next one starting <= 5 min after it ends -> focus on the next, backToBack', () => {
    const f = pickFocus([mtg('now', -50, 2), mtg('next', 6, 36)], now, H)
    expect(f).toMatchObject({ backToBack: true })
    expect(f.focus?.id).toBe('next')
    expect(f.current?.id).toBe('now')
  })
  it('a gap of more than 5 min is not back-to-back (focus stays on the current meeting, as before)', () => {
    const f = pickFocus([mtg('now', -50, 2), mtg('next', 8, 36)], now, H)
    expect(f.backToBack).toBe(false)
    expect(f.focus?.id).toBe('now')
  })
  it('not in a meeting -> first upcoming, never back-to-back', () => {
    const f = pickFocus([mtg('a', 12, 42), mtg('b', 43, 60)], now, H)
    expect(f).toMatchObject({ backToBack: false })
    expect(f.focus?.id).toBe('a')
  })
  it('respects the horizon and ignores ended meetings', () => {
    expect(pickFocus([mtg('old', -60, -10), mtg('far', 600, 630)], now, 60 * 60000).focus).toBeUndefined()
  })
  it('demo b2b scenario is detected', () => {
    const f = pickFocus(demoMeetings(now, 'b2b'), now, H)
    expect(f.backToBack).toBe(true)
    expect(f.focus?.title).toMatch(/^Design review/)
  })
})

describe('meeting context query (read-only, allow-listed grammar)', () => {
  it('builds a from/to query over valid addresses with a day window', () => {
    expect(contextQuery(['Marco@Example.com', 'sara@example.com'], 14)).toBe('(from:marco@example.com OR to:marco@example.com OR from:sara@example.com OR to:sara@example.com) newer_than:14d')
  })
  it('drops invalid addresses, de-duplicates, caps people at 4 and days at 30', () => {
    const q = contextQuery(['a@x.io', 'A@x.io', 'not an email', 'x") OR in:anywhere', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'], 90)!
    expect(q.match(/from:/g)).toHaveLength(4)
    expect(q).not.toContain('anywhere')
    expect(q).toMatch(/newer_than:30d$/)
    expect(contextQuery(['nope'])).toBeNull()
  })
})

describe('offline pending items (fallback summarizer)', () => {
  it('takes the first request-like sentence of each person\'s newest mail, adds no words', () => {
    const items = heuristicPending([...demoEmails(now), ...demoHistory(now)].filter(e => ['sara@example.com', 'marco@example.com'].includes(e.fromAddress)))
    expect(items).toEqual(['Sara: check slide 4 before 15:30', 'Marco: bring the drop-off numbers per step'])
  })
  it('skips "no action needed" mail and mail without a request; caps the count', () => {
    expect(heuristicPending([mail('Travel', 't@x.io', 'Seat 12A. No action needed?', 1), mail('Ann', 'a@x.io', 'Thanks for yesterday.', 2)])).toEqual([])
    const many = ['a', 'b', 'c', 'd'].map((n, i) => mail(n.toUpperCase(), `${n}@x.io`, 'Please send the deck.', i))
    expect(heuristicPending(many, 3)).toHaveLength(3)
  })
  it('strips greetings and polite openers', () => {
    expect(heuristicPending([mail('Giulia Bianchi', 'g@x.io', 'Hi, can you confirm the budget numbers before the planning meeting?', 5)])).toEqual(['Giulia: confirm the budget numbers before the planning meeting'])
  })
})

describe('pending-drafts reminder: stale drafts and the moment to surface them', () => {
  const d = (id: string, hoursAgo: number): PendingDraft => ({ id, to: id, subject: '', createdAt: new Date(now.getTime() - hoursAgo * 3600000) })
  it('stale = at least 3 days old, oldest first', () => {
    expect(staleDrafts([d('new', 20), d('6d', 146), d('3d', 73), d('2d', 60)], now).map(x => x.id)).toEqual(['6d', '3d'])
  })
  const base = { now, timeZone: 'Europe/Rome', ended: [] as Meeting[], backToBack: false, count: 2 }
  it('right after a meeting, with nothing starting soon -> after_meeting', () => {
    expect(draftMoment({ ...base, ended: [mtg('standup', -23, -8)], next: mtg('1:1', 90, 120) })).toBe('after_meeting')
  })
  it('not if the next meeting starts within 10 min, during a meeting, or back-to-back', () => {
    expect(draftMoment({ ...base, ended: [mtg('s', -23, -8)], next: mtg('n', 9, 30) })).toBe('later')
    expect(draftMoment({ ...base, ended: [mtg('s', -23, -8)], next: mtg('n', -5, 30) })).toBe('later')
    expect(draftMoment({ ...base, ended: [mtg('s', -23, -8)], next: mtg('n', 90, 120), backToBack: true })).toBe('later')
  })
  it('end of day (>= 17:00 local) with no meeting in the next 30 min -> end_of_day', () => {
    const eve = new Date('2026-11-23T16:30:00Z') // 17:30 Rome
    expect(draftMoment({ ...base, now: eve })).toBe('end_of_day')
    expect(draftMoment({ ...base, now: eve, next: { ...mtg('late', 0, 1), start: new Date(eve.getTime() + 20 * 60000), end: new Date(eve.getTime() + 50 * 60000) } })).toBe('later')
  })
  it('no drafts -> never promoted', () => {
    expect(draftMoment({ ...base, count: 0, ended: [mtg('s', -23, -8)] })).toBe('later')
  })
})
