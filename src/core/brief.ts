// Brief composition: data sources -> BriefCard -> glasses pages (<= 6 lines x 40 chars).
import type { BriefCard, CalendarSource, DraftTracker, EmailItem, MailSource, Meeting, Summarizer } from './types'
import { LINE_CHARS, MAX_LINES, clean, leftRight, limitWords, truncate, wrap, wrapClamp } from './text'
import { clock, relativeStart } from './time'
import { AFTER_MEETING_MIN, CONTEXT_DAYS, CONTEXT_LIMIT, PENDING_MAX, STALE_DAYS, ageDays, draftMoment, pickFocus, staleDrafts } from './context'

export interface BriefOptions {
  now: Date
  timeZone: string
  maxEmails?: number
  /** Meetings that start later than this many minutes away are not shown. */
  horizonMinutes?: number
  demo?: boolean
  /** App-created drafts (optional): enables the pending-drafts reminder. */
  drafts?: DraftTracker
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
  const { focus: meeting, current, backToBack } = pickFocus(meetings, o.now, horizon)
  let meetingLine: string | undefined
  let pending: string[] = []
  if (meeting) {
    const [line, items] = await Promise.all([
      ai.meetingBrief(meeting, MEETING_BRIEF_WORDS).catch(e => {
        errors.push(`summary: ${msg(e)}`)
        return clean(meeting.description ?? '')
      }),
      meetingContext(meeting, mail, ai, errors),
    ])
    meetingLine = limitWords(line, MEETING_BRIEF_WORDS)
    pending = items
  }
  const summaries = await Promise.all(
    emails.map(item =>
      ai.emailSummary(item, EMAIL_SUMMARY_WORDS)
        .catch(e => { errors.push(`summary: ${msg(e)}`); return item.snippet })
        .then(s => ({ item, summary: limitWords(s, EMAIL_SUMMARY_WORDS) })),
    ),
  )
  const card: BriefCard = { meeting, meetingLine, emails: summaries, pending, demo: !!o.demo, errors }
  if (backToBack && current) card.backToBack = { current }
  if (o.drafts) card.drafts = await draftsInfo(o.drafts, cal, o, meeting, backToBack, errors)
  return card
}

/** Recent mail with the attendees (read-only, CONTEXT_DAYS / CONTEXT_LIMIT) -> pending items. */
async function meetingContext(m: Meeting, mail: MailSource, ai: Summarizer, errors: string[]): Promise<string[]> {
  if (!mail.withPeople || !m.attendeeEmails?.length) return []
  let recent: EmailItem[]
  try {
    recent = await mail.withPeople(m.attendeeEmails, { days: CONTEXT_DAYS, limit: CONTEXT_LIMIT })
  } catch (e) {
    errors.push(`context: ${msg(e)}`)
    return []
  }
  if (!recent.length) return []
  const items = await ai.pendingItems(m, recent.slice(0, CONTEXT_LIMIT), PENDING_MAX).catch(e => { errors.push(`context: ${msg(e)}`); return [] as string[] })
  return items.map(clean).filter(Boolean).slice(0, PENDING_MAX)
}

export async function draftsInfo(t: DraftTracker, cal: CalendarSource, o: BriefOptions, next: Meeting | undefined, backToBack: boolean, errors: string[]) {
  const list = await t.pending().catch(e => { errors.push(`drafts: ${msg(e)}`); return [] })
  const ended = cal.recentlyEnded ? await cal.recentlyEnded(o.now, AFTER_MEETING_MIN).catch(() => []) : []
  const moment = draftMoment({ now: o.now, timeZone: o.timeZone, ended, next, backToBack, count: list.length })
  return { list, stale: staleDrafts(list, o.now), moment }
}

export type PageKind = 'meeting' | 'notes' | 'email' | 'empty' | 'glance' | 'pending' | 'drafts'
export interface Page {
  kind: PageKind
  lines: string[]
  /** Index into card.emails for email pages. */
  emailIndex?: number
  /** Drafts page: ids of stale app-created drafts that a confirmed tap may discard. */
  staleIds?: string[]
  /** Drafts page: the confirm screen shown before discarding. */
  confirmLines?: string[]
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
  const drafts = card.drafts && card.drafts.list.length ? draftsPage(card, o, h) : undefined
  if (drafts && card.drafts!.moment !== 'later') pages.push(drafts)
  if (card.meeting) {
    const m = card.meeting
    const when = relativeStart(o.now, m.start, m.end)
    if (card.backToBack) {
      // Back-to-back: one glance before the full brief (who · what, then one pending item or the brief).
      const who = m.attendees.length ? m.attendees.slice(0, 2).join(', ') + (m.attendees.length > 2 ? ` +${m.attendees.length - 2}` : '') : ''
      pages.push({
        kind: 'glance',
        lines: [
          header('BACK-TO-BACK', h),
          truncate([`Next ${clock(m.start, o.timeZone)} ${when}`, m.location].filter(Boolean).join(' · '), LINE_CHARS),
          truncate([who, m.title].filter(Boolean).join(': '), LINE_CHARS),
          ...wrapClamp(card.pending[0] ? `Pending: ${card.pending[0]}` : (card.meetingLine || 'No notes in the invite.'), 2),
          'Tap or swipe: full brief',
        ].slice(0, MAX_LINES),
      })
    }
    const lines = [header('NEXT MEETING', h), truncate(m.title, LINE_CHARS)]
    lines.push(truncate([`${clock(m.start, o.timeZone)} ${when}`, m.location].filter(Boolean).join(' · '), LINE_CHARS))
    const briefLines = wrapClamp(card.meetingLine || 'No notes in the invite.', 2)
    lines.push(...briefLines)
    const p = card.pending.length
    lines.push(truncate(p ? `${p} pending · ${n === 0 ? 'inbox clear' : `${n} unread`} · swipe` : inboxTag, LINE_CHARS))
    pages.push({ kind: 'meeting', lines: lines.slice(0, MAX_LINES) })
    if (p) {
      pages.push({
        kind: 'pending',
        lines: [header(`PENDING · ${p} from mail`, h), ...pendingBody(card.pending, MAX_LINES - 2), truncate(`Mail with them, last ${CONTEXT_DAYS} days`, LINE_CHARS)].slice(0, MAX_LINES),
      })
    }
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
  if (drafts && card.drafts!.moment === 'later') pages.push(drafts)
  if (card.errors.length && pages.length) {
    // Surface failures honestly on the last page if it has room.
    const last = pages[pages.length - 1]
    if (last.lines.length < MAX_LINES) last.lines.push(truncate(`! ${card.errors[0]}`, LINE_CHARS))
  }
  return pages
}

/** Each item gets up to 2 lines while every remaining item still gets at least one. */
function pendingBody(items: string[], budget: number): string[] {
  const out: string[] = []
  items.forEach((x, i) => {
    const left = budget - out.length - (items.length - i - 1)
    if (left <= 0) return
    const w = wrapClamp(`- ${x}`, Math.min(2, left))
    out.push(...w) // (the renderer collapses leading spaces, so continuation lines are not indented)
  })
  return out.slice(0, budget)
}

function draftsPage(card: BriefCard, o: { now: Date; timeZone: string }, h: { now: Date; timeZone: string; demo: boolean }): Page {
  const d = card.drafts!
  const n = d.list.length
  const lead = d.moment === 'after_meeting' ? 'Meeting over. ' : d.moment === 'end_of_day' ? 'End of day. ' : ''
  const oldest = [...d.list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
  const age = (x: typeof oldest) => { const a = ageDays(x, o.now); return a === 0 ? 'today' : `${a} d` }
  const s = d.stale.length
  const lines = [
    header(`DRAFTS WAITING`, h),
    truncate(`${lead}${n} ${n === 1 ? 'reply' : 'replies'} not sent yet`, LINE_CHARS),
    'In Gmail Drafts: send them there.',
    truncate(s ? `${s} older than ${STALE_DAYS_LABEL} · oldest ${age(oldest)}` : `Oldest: ${oldest.to}, ${age(oldest)}`, LINE_CHARS),
    s ? 'Tap: tidy up old · swipe: next' : 'Swipe: next',
  ]
  const page: Page = { kind: 'drafts', lines }
  if (s) {
    page.staleIds = d.stale.map(x => x.id)
    const names = d.stale.slice(0, 2).map(x => truncate(`${x.to} · ${age(x)}`, LINE_CHARS))
    if (s > 2) names[1] = truncate(`${d.stale[1].to} · ${age(d.stale[1])} +${s - 2} more`, LINE_CHARS)
    page.confirmLines = [
      `DISCARD ${s} OLD ${s === 1 ? 'DRAFT' : 'DRAFTS'}?`,
      ...names,
      'Only drafts Glance Brief made.',
      'Tap: discard · swipe: keep',
    ]
  }
  return page
}
const STALE_DAYS_LABEL = `${STALE_DAYS} days`

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
