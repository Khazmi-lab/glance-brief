// DEMO / TEST DATA ONLY. Invented people and messages so the simulator demo runs
// without anyone's real account. The glasses header shows "DEMO" whenever these
// sources are active. A real demo uses the user's own Google account via the backend.
import type { CalendarSource, DraftTracker, EmailItem, MailSource, Meeting, PendingDraft, ReplySink } from '../core/types'

/** DEMO scenarios (launch URL ?demo=...):
 *  - default: next meeting in 12 min, pending items from mail with the attendees, drafts card at the end
 *  - b2b:     in "Sprint planning" (ends in 2 min), design review starts 2 min later -> glance card first
 *  - after:   standup ended 8 min ago, next 1:1 in 90 min -> "drafts waiting" card first */
export type DemoScenario = 'default' | 'b2b' | 'after'

const REVIEW = (t: (m: number) => Date, start: number): Meeting => ({
  id: 'demo-1',
  title: 'Design review: onboarding v2 (DEMO)',
  start: t(start), end: t(start + 30),
  location: 'Room Aurora',
  description:
    'Decide between the two onboarding flows. Marco wants the 3-step flow; data from last week shows step 2 drop-off at 38%. Bring the updated mockups. Legal still has to sign off the consent copy.',
  attendees: ['Marco (demo)', 'Sara (demo)'],
  attendeeEmails: ['marco@example.com', 'sara@example.com'],
})

export function demoMeetings(now: Date, scenario: DemoScenario = 'default'): Meeting[] {
  const t = (min: number) => new Date(now.getTime() + min * 60000)
  if (scenario === 'b2b')
    return [
      { id: 'demo-0', title: 'Sprint planning (DEMO)', start: t(-50), end: t(2), attendees: ['Luca (demo)'], attendeeEmails: ['luca@example.com'] },
      REVIEW(t, 4),
    ]
  if (scenario === 'after')
    return [
      { id: 'demo-s', title: 'Standup (DEMO)', start: t(-23), end: t(-8), attendees: ['Luca (demo)'], attendeeEmails: ['luca@example.com'] },
      { id: 'demo-2', title: '1:1 (DEMO)', start: t(90), end: t(120), attendees: ['Luca (demo)'], attendeeEmails: ['luca@example.com'] },
    ]
  return [
    REVIEW(t, 12),
    { id: 'demo-2', title: '1:1 (DEMO)', start: t(120), end: t(150), attendees: ['Luca (demo)'], attendeeEmails: ['luca@example.com'] },
  ]
}

export function demoEmails(now: Date): EmailItem[] {
  const t = (min: number) => new Date(now.getTime() - min * 60000)
  return [
    { id: 'd1', threadId: 'd1', from: 'Sara (demo)', fromAddress: 'sara@example.com', subject: 'Mockups for the review', snippet: 'Uploaded the new onboarding mockups to the shared folder. Can you check slide 4 before 15:30? The consent text changed.', receivedAt: t(8) },
    { id: 'd2', threadId: 'd2', from: 'Travel desk (demo)', fromAddress: 'travel@example.com', subject: 'Train to Milan confirmed', snippet: 'Your train on Thursday leaves at 08:05 from platform 7. Seat 12A. No action needed.', receivedAt: t(40) },
    { id: 'd3', threadId: 'd3', from: 'Luca (demo)', fromAddress: 'luca@example.com', subject: 'Can we move our 1:1?', snippet: 'Something came up, could we move today\'s 1:1 to tomorrow morning, 10:00 or 11:00?', receivedAt: t(65) },
  ]
}

/** Older (already read) DEMO mail, used only as meeting context. */
export function demoHistory(now: Date): EmailItem[] {
  const t = (h: number) => new Date(now.getTime() - h * 3600000)
  return [
    { id: 'h1', threadId: 'h1', from: 'Marco (demo)', fromAddress: 'marco@example.com', subject: 'Re: onboarding flows', snippet: 'I still prefer the 3-step flow. Can you bring the drop-off numbers per step?', receivedAt: t(26) },
    { id: 'h2', threadId: 'h2', from: 'Sara (demo)', fromAddress: 'sara@example.com', subject: 'Consent copy', snippet: 'Legal sent comments on the consent copy. Please confirm the final wording with them by Thursday.', receivedAt: t(50) },
    { id: 'h3', threadId: 'h3', from: 'Marco (demo)', fromAddress: 'marco@example.com', subject: 'Lunch?', snippet: 'Thanks for yesterday, it was fun.', receivedAt: t(70) },
  ]
}

export class DemoCalendar implements CalendarSource {
  constructor(private base: Date, private scenario: DemoScenario = 'default') {}
  async upcoming(now: Date, limit: number) {
    return demoMeetings(this.base, this.scenario).filter(m => m.end.getTime() > now.getTime()).slice(0, limit)
  }
  async recentlyEnded(now: Date, withinMin: number) {
    const t = now.getTime()
    return demoMeetings(this.base, this.scenario).filter(m => m.end.getTime() <= t && t - m.end.getTime() <= withinMin * 60000)
  }
}
export class DemoMail implements MailSource {
  constructor(private base: Date) {}
  async unread(limit: number) { return demoEmails(this.base).slice(0, limit) }
  async withPeople(addresses: string[], o: { days: number; limit: number }) {
    const want = new Set(addresses.map(a => a.toLowerCase()))
    const since = this.base.getTime() - o.days * 86400000
    return [...demoEmails(this.base), ...demoHistory(this.base)]
      .filter(e => want.has(e.fromAddress) && e.receivedAt.getTime() >= since)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, o.limit)
  }
}
/** Demo sink: never touches any mailbox. */
export class DemoReplySink implements ReplySink {
  async saveReply(to: EmailItem) { return { ok: true, detail: `DEMO: draft to ${to.from} kept locally (nothing sent).`, draftId: `demo-${to.id}` } }
}

/** DEMO drafts ledger in memory: three invented app-created drafts (6 d, 4 d and 20 h old) plus any
 *  saved in this session. Like the backend ledger it only ever knows drafts the app created. */
export class DemoDrafts implements DraftTracker {
  private list: PendingDraft[]
  constructor(base: Date) {
    const ago = (h: number) => new Date(base.getTime() - h * 3600000)
    this.list = [
      { id: 'demo-old-1', to: 'Luca (demo)', subject: 'Re: Quarterly numbers', createdAt: ago(6 * 24 + 2) },
      { id: 'demo-old-2', to: 'Travel desk (demo)', subject: 'Re: Hotel in Milan', createdAt: ago(4 * 24 + 1) },
      { id: 'demo-new-1', to: 'Sara (demo)', subject: 'Re: Mockups', createdAt: ago(20) },
    ]
  }
  async pending() { return [...this.list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) }
  async discard(ids: string[]) {
    const known = new Set(this.list.map(d => d.id))
    if (ids.some(id => !known.has(id))) throw new Error('not a Glance Brief draft')
    const before = this.list.length
    this.list = this.list.filter(d => !ids.includes(d.id))
    return before - this.list.length
  }
  noteSaved(to: EmailItem, draftId: string | undefined, at: Date) {
    this.list.push({ id: draftId ?? `demo-${to.id}-${at.getTime()}`, to: to.from, subject: `Re: ${to.subject}`, createdAt: at })
  }
}
