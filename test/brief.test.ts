import { describe, expect, it } from 'vitest'
import { buildBrief, composePages } from '../src/core/brief'
import { GoogleCalendarSource } from '../src/adapters/google-calendar'
import { GmailSource } from '../src/adapters/gmail'
import { HeuristicSummarizer } from '../src/adapters/llm'
import { DemoCalendar, DemoMail } from '../src/adapters/demo'
import type { CalendarSource, MailSource } from '../src/core/types'
import { FakeHttp, expectFits, fixture } from './helpers'
import { LINE_CHARS, MAX_LINES } from '../src/core/text'

const now = new Date('2026-11-23T14:00:00Z')
const tz = 'Europe/Rome'
const http = () => new FakeHttp({
  '/calendar/v3/': fixture('calendar_events.json'),
  '/gmail/v1/users/me/messages?': fixture('gmail_list.json'),
  '/gmail/v1/users/me/messages/a1': fixture('gmail_a1.json'),
  '/gmail/v1/users/me/messages/a2': fixture('gmail_a2.json'),
})

describe('brief composition + paging', () => {
  it('builds meeting card, notes pages and one page per email, all within 6x40', async () => {
    const h = http()
    const card = await buildBrief(new GoogleCalendarSource(h), new GmailSource(h), new HeuristicSummarizer(), { now, timeZone: tz })
    expect(card.meeting?.id).toBe('m1')
    expect(card.errors).toEqual([])
    const pages = composePages(card, { now, timeZone: tz })
    expect(pages.map(p => p.kind)).toEqual(['meeting', 'pending', 'notes', 'notes', 'email', 'email'])
    for (const p of pages) {
      expect(p.lines.length).toBeLessThanOrEqual(MAX_LINES)
      for (const l of p.lines) expect(l.length).toBeLessThanOrEqual(LINE_CHARS)
      expectFits(p.lines.join('\n'))
    }
    expect(pages[0].lines[0]).toBe('NEXT MEETING · 15:00')
    expect(pages[0].lines[2]).toBe('15:12 in 12 min · Meeting room 3...')
    expect(pages[0].lines[3]).toBe('Agenda: 1. Q1 roadmap & staffing.')
    expect(pages[0].lines.at(-1)).toBe('1 pending · 2 unread · swipe')
    expect(pages[1].lines[0]).toMatch(/^PENDING · 1 from mail/)
    expect(pages[2].lines[0]).toMatch(/^NOTES 1\/2/)
    expect(pages[3].lines.at(-1)).toBe('With Giulia, omar')
    expect(pages[4].lines[1]).toBe('Giulia Bianchi')
    expect(pages[4].lines[0]).toMatch(/^INBOX 1\/2/)
  })
  it('notes pages contain the whole description in order', async () => {
    const h = http()
    const card = await buildBrief(new GoogleCalendarSource(h), new GmailSource(h), new HeuristicSummarizer(), { now, timeZone: tz })
    const pages = composePages(card, { now, timeZone: tz }).filter(p => p.kind === 'notes')
    const text = pages.flatMap(p => p.lines.slice(1, p.lines.length - 1)).join(' ')
    expect(text).toBe(card.meeting!.description)
  })
  it('ignores meetings beyond the horizon and shows an empty card', async () => {
    const h = http()
    const card = await buildBrief(new GoogleCalendarSource(h), new GmailSource(h), new HeuristicSummarizer(), { now, timeZone: tz, horizonMinutes: 5 })
    expect(card.meeting).toBeUndefined()
    const pages = composePages(card, { now, timeZone: tz })
    expect(pages[0].kind).toBe('empty')
    expect(pages[0].lines[1]).toBe('No meetings in the next 12 h.')
  })
  it('degrades gracefully when a source fails and says so on screen', async () => {
    const bad: MailSource = { unread: async () => { throw new Error('HTTP 401') } }
    const cal: CalendarSource = { upcoming: async () => [] }
    const card = await buildBrief(cal, bad, new HeuristicSummarizer(), { now, timeZone: tz })
    expect(card.errors).toEqual(['mail: HTTP 401'])
    const pages = composePages(card, { now, timeZone: tz })
    expect(pages[0].lines.at(-1)).toBe('! mail: HTTP 401')
  })
  it('falls back to the raw description when the summarizer throws', async () => {
    const s = new HeuristicSummarizer()
    s.meetingBrief = async () => { throw new Error('llm down') }
    const card = await buildBrief(new DemoCalendar(now), new DemoMail(now), s, { now, timeZone: tz, demo: true })
    expect(card.meetingLine).toMatch(/^Decide between the two onboarding flows/)
    expect(card.errors).toContain('summary: llm down')
  })
  it('demo data is labelled DEMO on every page header', async () => {
    const card = await buildBrief(new DemoCalendar(now), new DemoMail(now), new HeuristicSummarizer(), { now, timeZone: tz, demo: true })
    const pages = composePages(card, { now, timeZone: tz })
    expect(pages.length).toBeGreaterThan(3)
    for (const p of pages) { expect(p.lines[0]).toMatch(/ · DEMO \d\d:\d\d$/); expectFits(p.lines.join('\n')) }
  })
})
