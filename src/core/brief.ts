// Brief composition: data sources -> BriefCard -> glasses pages (<= 6 lines x 40 chars).
import type { BriefCard, CalendarSource, MailSource, Summarizer } from './types'
import { LINE_CHARS, MAX_LINES, clean, leftRight, limitWords, truncate, wrap, wrapClamp } from './text'
import { clock, relativeStart } from './time'

export interface BriefOptions {
  now: Date
  timeZone: string
  maxEmails?: number
  /** Meetings that start later than this many minutes away are not shown. */
  horizonMinutes?: number
  demo?: boolean
}

export const MEETING_BRIEF_WORDS = 14
export const EMAIL_SUMMARY_WORDS = 12

/** Fetch from the sources and summarise. Source/LLM failures degrade to partial cards. */
export async function buildBrief(
  cal: CalendarSource,
  mail: MailSource,
  ai: Summarizer,
  o: BriefOptions,
): Promise<BriefCard> {
  const errors: string[] = []
  const horizon = (o.horizonMinutes ?? 12 * 60) * 60000
  const [meetings, emails] = await Promise.all([
    cal.upcoming(o.now, 3).catch(e => { errors.push(`calendar: ${msg(e)}`); return [] }),
    mail.unread(o.maxEmails ?? 5).catch(e => { errors.push(`mail: ${msg(e)}`); return [] }),
  ])
  const meeting = meetings
    .filter(m => m.end.getTime() > o.now.getTime() && m.start.getTime() - o.now.getTime() <= horizon)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0]
  let meetingLine: string | undefined
  if (meeting) {
    meetingLine = await ai.meetingBrief(meeting, MEETING_BRIEF_WORDS).catch(e => {
      errors.push(`summary: ${msg(e)}`)
      return clean(meeting.description ?? '')
    })
    meetingLine = limitWords(meetingLine, MEETING_BRIEF_WORDS)
  }
  const summaries = await Promise.all(
    emails.map(item =>
      ai.emailSummary(item, EMAIL_SUMMARY_WORDS)
        .catch(e => { errors.push(`summary: ${msg(e)}`); return item.snippet })
        .then(s => ({ item, summary: limitWords(s, EMAIL_SUMMARY_WORDS) })),
    ),
  )
  return { meeting, meetingLine, emails: summaries, demo: !!o.demo, errors }
}

export type PageKind = 'meeting' | 'notes' | 'email' | 'empty'
export interface Page {
  kind: PageKind
  lines: string[]
  /** Index into card.emails for email pages. */
  emailIndex?: number
}

function header(left: string, o: { now: Date; timeZone: string; demo: boolean }): string {
  return leftRight(left, (o.demo ? 'DEMO ' : '') + clock(o.now, o.timeZone))
}

/** Compose the page sequence the user scrolls through. Every page fits MAX_LINES x LINE_CHARS. */
export function composePages(card: BriefCard, o: { now: Date; timeZone: string }): Page[] {
  const h = { ...o, demo: card.demo }
  const pages: Page[] = []
  const n = card.emails.length
  const inboxTag = n === 0 ? 'Inbox clear' : `${n} unread · swipe`
  if (card.meeting) {
    const m = card.meeting
    const when = relativeStart(o.now, m.start, m.end)
    const lines = [header('NEXT MEETING', h), truncate(m.title, LINE_CHARS)]
    lines.push(truncate([`${clock(m.start, o.timeZone)} ${when}`, m.location].filter(Boolean).join(' · '), LINE_CHARS))
    const briefLines = wrapClamp(card.meetingLine || 'No notes in the invite.', 2)
    lines.push(...briefLines)
    lines.push(truncate(inboxTag, LINE_CHARS))
    pages.push({ kind: 'meeting', lines: lines.slice(0, MAX_LINES) })
    // Paging: long invite notes continue on their own pages (4 body lines each).
    const notes = wrap(m.description ?? '')
    const body = MAX_LINES - 2
    if (notes.length > 0) {
      const total = Math.ceil(notes.length / body)
      for (let p = 0; p < total; p++) {
        const lines = [header(`NOTES ${p + 1}/${total}`, h), ...notes.slice(p * body, (p + 1) * body)]
        if (m.attendees.length) lines.push(truncate(`With ${m.attendees.join(', ')}`, LINE_CHARS))
        pages.push({ kind: 'notes', lines })
      }
    }
  } else {
    pages.push({ kind: 'empty', lines: [header('GLANCE BRIEF', h), 'No meetings in the next 12 h.', '', truncate(inboxTag, LINE_CHARS)] })
  }
  card.emails.forEach(({ item, summary }, i) => {
    pages.push({
      kind: 'email',
      emailIndex: i,
      lines: [
        header(`INBOX ${i + 1}/${n}`, h),
        truncate(item.from, LINE_CHARS),
        truncate(item.subject || '(no subject)', LINE_CHARS),
        ...wrapClamp(summary, 2),
        'Tap: draft reply · swipe: next',
      ].slice(0, MAX_LINES),
    })
  })
  if (card.errors.length && pages.length) {
    // Surface failures honestly on the last page if it has room.
    const last = pages[pages.length - 1]
    if (last.lines.length < MAX_LINES) last.lines.push(truncate(`! ${card.errors[0]}`, LINE_CHARS))
  }
  return pages
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
