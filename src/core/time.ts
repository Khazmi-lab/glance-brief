// Relative-time strings for the meeting card. Pure, timezone passed in.

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

/** "in 12 min", "in 1 h 05", "now", "started 5 min ago", "ended". */
export function relativeStart(now: Date, start: Date, end: Date): string {
  if (now.getTime() >= end.getTime()) return 'ended'
  const m = minutesBetween(now, start)
  if (m > 0) {
    if (m < 60) return `in ${m} min`
    const h = Math.floor(m / 60)
    const mm = m % 60
    if (h >= 24) return `in ${Math.floor(h / 24)} d`
    return mm === 0 ? `in ${h} h` : `in ${h} h ${String(mm).padStart(2, '0')}`
  }
  if (m === 0) return 'now'
  return `started ${-m} min ago`
}

/** "14:30" in the given IANA zone (falls back to UTC on a bad zone). */
export function clock(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(d)
  }
}
