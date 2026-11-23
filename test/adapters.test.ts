import { describe, expect, it } from 'vitest'
import { GoogleCalendarSource, parseEvents, stripHtml } from '../src/adapters/google-calendar'
import { GmailDraftSink, GmailSource, buildReplyRaw, parseFrom } from '../src/adapters/gmail'
import { FallbackSummarizer, HeuristicSummarizer, LlmSummarizer, oneLine } from '../src/adapters/llm'
import { FakeHttp, fixture } from './helpers'

const now = new Date('2026-11-23T14:00:00Z')

describe('Google Calendar adapter (fixture = test data)', () => {
  it('keeps timed, confirmed, not-declined events, soonest first', () => {
    const ms = parseEvents(fixture('calendar_events.json'))
    expect(ms.map(m => m.id)).toEqual(['m1', 'm2'])
    const m1 = ms[0]
    expect(m1.attendees).toEqual(['Giulia', 'omar'])
    expect(m1.joinUrl).toBe('https://meet.example.com/abc-defg-hij')
    expect(m1.description).toMatch(/^Agenda: 1\. Q1 roadmap & staffing\./)
    expect(m1.description).not.toMatch(/<|&amp;/)
  })
  it('calls events.list read-only with the right query', async () => {
    const http = new FakeHttp({ '/calendar/v3/calendars/primary/events': fixture('calendar_events.json') })
    const ms = await new GoogleCalendarSource(http).upcoming(now, 1)
    expect(ms).toHaveLength(1)
    const u = new URL('http://x' + http.gets[0])
    expect(u.searchParams.get('singleEvents')).toBe('true')
    expect(u.searchParams.get('orderBy')).toBe('startTime')
    expect(u.searchParams.get('timeMin')).toBe('2026-11-23T13:00:00.000Z')
    expect(http.posts).toHaveLength(0)
  })
  it('strips html entities', () => {
    expect(stripHtml('a<br/>b &amp; c')).toBe('a b & c')
  })
})

describe('Gmail adapter (fixture = test data)', () => {
  const http = () => new FakeHttp({
    '/gmail/v1/users/me/messages?': fixture('gmail_list.json'),
    '/gmail/v1/users/me/messages/a1': fixture('gmail_a1.json'),
    '/gmail/v1/users/me/messages/a2': fixture('gmail_a2.json'),
  }, () => ({ id: 'draft-1' }))
  it('lists unread inbox and fetches metadata only', async () => {
    const h = http()
    const items = await new GmailSource(h).unread(5)
    expect(items.map(i => i.id)).toEqual(['a1', 'a2'])
    expect(items[0].from).toBe('Giulia Bianchi')
    expect(items[0].fromAddress).toBe('giulia@example.com')
    expect(items[0].snippet).toContain("& I'd rather")
    expect(items[1].from).toBe('shipping@example.com')
    expect(h.gets[0]).toContain('is%3Aunread')
    expect(h.gets.slice(1).every(g => g.includes('format=metadata'))).toBe(true)
  })
  it('parses From headers', () => {
    expect(parseFrom('Anna <a@x.it>')).toEqual({ name: 'Anna', address: 'a@x.it' })
    expect(parseFrom('<a@x.it>')).toEqual({ name: 'a@x.it', address: 'a@x.it' })
  })
  it('creates a Gmail DRAFT (never messages.send) with a proper reply', async () => {
    const h = http()
    const [item] = await new GmailSource(h).unread(1)
    const r = await new GmailDraftSink(h).saveReply(item, 'Yes, sending them by 15:30. Grazie!')
    expect(r.ok).toBe(true)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].path).toBe('/gmail/v1/users/me/drafts')
    expect(h.posts.some(p => p.path.includes('send'))).toBe(false)
    const raw = h.posts[0].body.message.raw as string
    const mime = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
    expect(mime).toContain('To: giulia@example.com')
    expect(mime).toContain('Subject: Re: Budget numbers for planning')
    expect(mime).toContain('Grazie!')
    expect(h.posts[0].body.message.threadId).toBe('t1')
  })
  it('does not double "Re:"', () => {
    const raw = buildReplyRaw({ id: 'x', threadId: 'x', from: 'a', fromAddress: 'a@x', subject: 'RE: hi', snippet: '', receivedAt: now }, 'ok')
    expect(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))).toContain('Subject: RE: hi\r\n')
  })
})

describe('Summarizers', () => {
  const email = { id: 'e', threadId: 'e', from: 'Giulia Bianchi', fromAddress: 'g@x', subject: 'Budget', snippet: 'Can you confirm the numbers by 16:00?', receivedAt: now }
  it('LLM adapter sends an OpenAI-compatible request and forces one line', async () => {
    const h = new FakeHttp({}, () => ({ choices: [{ message: { content: '"Giulia needs budget numbers confirmed by 16:00 today for finance."\nextra' } }] }))
    const s = new LlmSummarizer(h, 'test-model')
    expect(await s.emailSummary(email, 8)).toBe('Giulia needs budget numbers confirmed by 16:00 today...')
    expect(h.posts[0].path).toBe('/llm/v1/chat/completions')
    expect(h.posts[0].body.model).toBe('test-model')
    expect(h.posts[0].body.messages[0].role).toBe('system')
  })
  it('LLM adapter rejects empty output; fallback keeps working', async () => {
    const h = new FakeHttp({}, () => ({ choices: [{ message: { content: '  ' } }] }))
    await expect(new LlmSummarizer(h, 'm').replyDraft(email)).rejects.toThrow('empty')
    const f = new FallbackSummarizer(new LlmSummarizer(h, 'm'), new HeuristicSummarizer())
    expect(await f.replyDraft(email)).toMatch(/^Thanks Giulia/)
  })
  it('heuristic meeting brief uses the first sentence', async () => {
    const s = new HeuristicSummarizer()
    expect(await s.meetingBrief({ id: '1', title: 't', start: now, end: now, attendees: [], description: 'Decide on X. Then Y.' }, 10)).toBe('Decide on X.')
    expect(await s.meetingBrief({ id: '1', title: 't', start: now, end: now, attendees: ['Ann'] }, 10)).toBe('With Ann')
  })
  it('oneLine strips quotes and keeps the first non-empty line', () => {
    expect(oneLine('\n  `hello`  \nworld')).toBe('hello')
  })
})
