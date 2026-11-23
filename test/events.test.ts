import { describe, expect, it } from 'vitest'
import { EV, mapEvent } from '../src/core/events'

describe('event routing', () => {
  it('treats a sysEvent with omitted eventType as click (CLICK=0 is omitted on the wire)', () => {
    expect(mapEvent({ sysEvent: { eventSource: 1 } as any })).toEqual({ type: 'click' })
  })
  it('does not invent a click when no envelope is present', () => {
    expect(mapEvent({})).toBeNull()
    expect(mapEvent({ audioEvent: { audioPcm: [] } })).toBeNull()
  })
  it('maps scrolls from textEvent', () => {
    expect(mapEvent({ textEvent: { eventType: EV.SCROLL_BOTTOM } })).toEqual({ type: 'down' })
    expect(mapEvent({ textEvent: { eventType: EV.SCROLL_TOP } })).toEqual({ type: 'up' })
  })
  it('double-click wins in any envelope', () => {
    expect(mapEvent({ textEvent: { eventType: EV.DOUBLE_CLICK } })).toEqual({ type: 'double_click' })
    expect(mapEvent({ sysEvent: { eventType: EV.DOUBLE_CLICK }, textEvent: {} })).toEqual({ type: 'double_click' })
  })
  it('lifecycle exits, long press, foreground events, string types', () => {
    expect(mapEvent({ sysEvent: { eventType: EV.SYSTEM_EXIT } })).toEqual({ type: 'lifecycle_exit' })
    expect(mapEvent({ sysEvent: { eventType: EV.LONG_PRESS } })).toEqual({ type: 'long_press' })
    expect(mapEvent({ sysEvent: { eventType: EV.FOREGROUND_ENTER } })).toBeNull()
    expect(mapEvent({ textEvent: { eventType: '2' } })).toEqual({ type: 'down' })
  })
})
