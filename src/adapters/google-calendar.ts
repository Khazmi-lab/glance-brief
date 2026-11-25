// Google Calendar API v3 read adapter (events.list on the primary calendar).
// Scope needed: https://www.googleapis.com/auth/calendar.readonly (read-only).
import type { CalendarSource, Meeting } from '../core/types'
import type { HttpClient } from './http'

interface GEvent {
  id?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[]
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Parse an events.list response body into meetings (timed, non-cancelled, not declined). */
export function parseEvents(body: unknown): Meeting[] {
  const items = (body as { items?: GEvent[] })?.items ?? []
  const out: Meeting[] = []
  for (const e of items) {
    if (e.status === 'cancelled') continue
    if (!e.start?.dateTime || !e.end?.dateTime) continue // all-day events are not "meetings"
    const me = e.attendees?.find(a => a.self)
    if (me?.responseStatus === 'declined') continue
    const start = new Date(e.start.dateTime)
    const end = new Date(e.end.dateTime)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
    const video = e.hangoutLink ?? e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri
    out.push({
      id: e.id ?? `${start.toISOString()}-${e.summary ?? ''}`,
      title: e.summary?.trim() || '(no title)',
      start,
      end,
      location: e.location?.trim() || undefined,
      description: e.description ? stripHtml(e.description).replace(/\s+/g, ' ').trim() : undefined,
      attendees: (e.attendees ?? []).filter(a => !a.self).map(a => a.displayName || (a.email ?? '').split('@')[0]).filter(Boolean),
      attendeeEmails: (e.attendees ?? []).filter(a => !a.self && a.email).map(a => a.email!.toLowerCase()),
      joinUrl: video,
    })
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

export class GoogleCalendarSource implements CalendarSource {
  constructor(private http: HttpClient, private calendarId = 'primary') {}
  private cache?: { at: number; events: Promise<Meeting[]> }
  /** One events.list per launch time (timeMin = now - 60 min) serves both upcoming and recentlyEnded. */
  private window(now: Date, limit: number): Promise<Meeting[]> {
    if (this.cache?.at === now.getTime()) return this.cache.events
    const q = new URLSearchParams({
      timeMin: new Date(now.getTime() - 60 * 60000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.max(limit * 3, 10)),
    })
    const events = this.http.getJson(`/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?${q}`).then(parseEvents)
    this.cache = { at: now.getTime(), events }
    events.catch(() => { if (this.cache?.events === events) this.cache = undefined })
    return events
  }
  async upcoming(now: Date, limit: number): Promise<Meeting[]> {
    return (await this.window(now, limit)).filter(m => m.end.getTime() > now.getTime()).slice(0, limit)
  }
  async recentlyEnded(now: Date, withinMin: number): Promise<Meeting[]> {
    const t = now.getTime()
    return (await this.window(now, 4)).filter(m => m.end.getTime() <= t && t - m.end.getTime() <= withinMin * 60000).sort((a, b) => b.end.getTime() - a.end.getTime())
  }
}
