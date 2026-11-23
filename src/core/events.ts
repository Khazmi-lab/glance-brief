// Map raw EvenHub bridge events to our Input. Mirrors the official template's
// routing rules: CLICK (=0) is omitted on the wire, so a missing eventType inside
// a present envelope means click; scrolls arrive via textEvent; double-tap is
// checked first in every envelope.
import type { Input } from './state'

// Numeric values from OsEventTypeList (even_hub_sdk 0.0.16).
export const EV = {
  CLICK: 0, SCROLL_TOP: 1, SCROLL_BOTTOM: 2, DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4, FOREGROUND_EXIT: 5, ABNORMAL_EXIT: 6, SYSTEM_EXIT: 7,
  IMU: 8, LONG_PRESS: 9, LONG_PRESS_RELEASE: 10,
} as const

type Envelope = { eventType?: number | string | null } | undefined | null

function typeOf(env: Envelope): number | null {
  if (!env) return null
  const t = env.eventType
  if (t === undefined || t === null) return EV.CLICK
  const n = typeof t === 'string' ? Number(t) : t
  return Number.isFinite(n) ? n : null
}

export type Mapped = Input | { type: 'lifecycle_exit' } | null

export function mapEvent(ev: { sysEvent?: Envelope; textEvent?: Envelope; listEvent?: Envelope; audioEvent?: unknown }): Mapped {
  const types = [typeOf(ev.sysEvent), typeOf(ev.textEvent), typeOf(ev.listEvent)].filter((t): t is number => t !== null)
  if (types.includes(EV.DOUBLE_CLICK)) return { type: 'double_click' }
  if (types.includes(EV.SYSTEM_EXIT) || types.includes(EV.ABNORMAL_EXIT)) return { type: 'lifecycle_exit' }
  // Scroll naming: SCROLL_TOP = swipe toward the top (previous), SCROLL_BOTTOM = next.
  if (types.includes(EV.SCROLL_TOP)) return { type: 'up' }
  if (types.includes(EV.SCROLL_BOTTOM)) return { type: 'down' }
  if (types.includes(EV.LONG_PRESS)) return { type: 'long_press' }
  if (types.includes(EV.CLICK)) return { type: 'click' }
  return null
}
