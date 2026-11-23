// DEMO / TEST DATA ONLY. Invented people and messages so the simulator demo runs
// without anyone's real account. The glasses header shows "DEMO" whenever these
// sources are active. A real demo uses the user's own Google account via the backend.
import type { CalendarSource, EmailItem, MailSource, Meeting, ReplySink } from '../core/types'

export function demoMeetings(now: Date): Meeting[] {
  const t = (min: number) => new Date(now.getTime() + min * 60000)
  return [
    {
      id: 'demo-1',
      title: 'Design review: onboarding v2 (DEMO)',
      start: t(12), end: t(42),
      location: 'Room Aurora',
      description:
        'Decide between the two onboarding flows. Marco wants the 3-step flow; data from last week shows step 2 drop-off at 38%. Bring the updated mockups. Legal still has to sign off the consent copy.',
      attendees: ['Marco (demo)', 'Sara (demo)'],
    },
    { id: 'demo-2', title: '1:1 (DEMO)', start: t(120), end: t(150), attendees: ['Luca (demo)'] },
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

export class DemoCalendar implements CalendarSource {
  constructor(private base: Date) {}
  async upcoming(_now: Date, limit: number) { return demoMeetings(this.base).slice(0, limit) }
}
export class DemoMail implements MailSource {
  constructor(private base: Date) {}
  async unread(limit: number) { return demoEmails(this.base).slice(0, limit) }
}
/** Demo sink: never touches any mailbox. */
export class DemoReplySink implements ReplySink {
  async saveReply(to: EmailItem) { return { ok: true, detail: `DEMO: draft to ${to.from} kept locally (nothing sent).` } }
}
