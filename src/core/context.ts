// v0.4 "real-life moments", all pure (no network):
//  - back-to-back detection: in a meeting, and the next one starts within B2B_GAP_MIN of its end
//  - meeting context: Gmail query for recent mail with the attendees + offline "pending items"
//  - pending-drafts reminder: which app-created drafts are stale, and WHEN to surface them
import type { DraftMoment, EmailItem, Meeting, PendingDraft } from './types'
import { clean, limitWords } from './text'

export const B2B_GAP_MIN = 5
export const CONTEXT_DAYS = 14
export const CONTEXT_LIMIT = 5
export const CONTEXT_MAX_PEOPLE = 4
export const PENDING_MAX = 3
export const STALE_DAYS = 3
/** "After a meeting" = one ended this recently... */
export const AFTER_MEETING_MIN = 30
/** ...and the next one is not about to start. */
export const QUIET_BEFORE_NEXT_MIN = 10
export const END_OF_DAY_HOUR = 17

export interface Focus {
  focus?: Meeting
  current?: Meeting
  backToBack: boolean
}

/** Pick the meeting the brief is about. Normally the first not-yet-ended meeting (in progress or next).
 *  Back-to-back: while a meeting is in progress and the next starts <= B2B_GAP_MIN after it ends,
 *  the focus moves to that next meeting so the user can prepare during the current one. */
export function pickFocus(meetings: Meeting[], now: Date, horizonMs: number): Focus {
  const t = now.getTime()
  const live = meetings.filter(m => m.end.getTime() > t).sort((a, b) => a.start.getTime() - b.start.getTime())
  const current = live.find(m => m.start.getTime() <= t)
  if (current) {
    const next = live.find(m => m !== current && m.start.getTime() >= current.start.getTime() && m.start.getTime() > t)
    if (next && next.start.getTime() - current.end.getTime() <= B2B_GAP_MIN * 60000 && next.start.getTime() - t <= horizonMs)
      return { focus: next, current, backToBack: true }
  }
  const first = live.find(m => m.start.getTime() - t <= horizonMs)
  return { focus: first, current, backToBack: false }
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24}$/

/** Gmail search for recent mail with these people, e.g. "(from:a OR to:a) newer_than:14d".
 *  Only valid addresses, at most CONTEXT_MAX_PEOPLE; the backend re-validates the grammar. */
export function contextQuery(addresses: string[], days = CONTEXT_DAYS): string | null {
  const ok = [...new Set(addresses.map(a => a.trim().toLowerCase()).filter(a => EMAIL.test(a)))].slice(0, CONTEXT_MAX_PEOPLE)
  if (!ok.length) return null
  const d = Math.min(Math.max(Math.round(days), 1), 30)
  return `(${ok.map(a => `from:${a} OR to:${a}`).join(' OR ')}) newer_than:${d}d`
}

const ASK = /\?|\b(can you|could you|would you|please|pls|need(s|ed)? (you|to)|waiting (on|for)|still (need|waiting|to)|reminder|by (mon|tue|wed|thu|fri|today|tomorrow|eod|end of day|\d))/i
const NO_ACTION = /\bno action (needed|required)\b/i
const LEAD = /^(hi|hello|hey)\b[^,.!?]*[,.!]\s*|^(so|also|and)\s+/i
const POLITE = /^(can|could|would) you (please )?|^please\s+|^pls\s+|^reminder:?\s*/i

/** Offline fallback: the first request-like sentence of each person's newest email.
 *  "Can you bring the numbers?" from "Marco (demo)" -> "Marco: bring the numbers". Adds no words. */
export function heuristicPending(emails: EmailItem[], max = PENDING_MAX): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of [...emails].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())) {
    const who = (e.from || e.fromAddress).split(/[\s(<@]/)[0] || e.fromAddress
    if (seen.has(e.fromAddress.toLowerCase())) continue
    const text = clean(`${e.snippet}`)
    if (NO_ACTION.test(text)) continue
    const sentence = text.split(/(?<=[.!?])\s+/).find(s => ASK.test(s))
    if (!sentence) continue
    let item = sentence.replace(LEAD, '').replace(POLITE, '').replace(/[?.!]+$/, '').trim()
    if (!item) continue
    item = item[0].toLowerCase() + item.slice(1)
    seen.add(e.fromAddress.toLowerCase())
    out.push(`${who}: ${limitWords(item, 10)}`)
    if (out.length >= max) break
  }
  return out
}

export function ageDays(d: PendingDraft, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - d.createdAt.getTime()) / 86400000))
}

export function staleDrafts(list: PendingDraft[], now: Date, days = STALE_DAYS): PendingDraft[] {
  return list.filter(d => ageDays(d, now) >= days).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

function localHour(now: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(now)) % 24
  } catch { return now.getUTCHours() }
}

/** When to surface "N drafts waiting" on the FIRST screen:
 *  - after_meeting: a meeting ended <= AFTER_MEETING_MIN ago and nothing starts within QUIET_BEFORE_NEXT_MIN
 *  - end_of_day: local time >= END_OF_DAY_HOUR and nothing starts within 30 min
 *  - later: otherwise (the drafts card sits at the end of the scroll; never interrupts a meeting brief) */
export function draftMoment(o: { now: Date; timeZone: string; ended: Meeting[]; next?: Meeting; backToBack: boolean; count: number }): DraftMoment {
  if (o.count === 0 || o.backToBack) return 'later'
  const t = o.now.getTime()
  const untilNext = o.next ? (o.next.start.getTime() - t) / 60000 : Infinity
  if (o.next && o.next.start.getTime() <= t) return 'later' // a meeting is in progress
  const justEnded = o.ended.some(m => m.end.getTime() <= t && t - m.end.getTime() <= AFTER_MEETING_MIN * 60000)
  if (justEnded && untilNext > QUIET_BEFORE_NEXT_MIN) return 'after_meeting'
  if (localHour(o.now, o.timeZone) >= END_OF_DAY_HOUR && untilNext > 30) return 'end_of_day'
  return 'later'
}
