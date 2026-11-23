import { describe, expect, it } from 'vitest'
import { clock, relativeStart } from '../src/core/time'

const now = new Date('2026-11-23T13:20:00Z')
const at = (min: number) => new Date(now.getTime() + min * 60000)

describe('relative time', () => {
  it.each([
    [12, 40, 'in 12 min'], [60, 90, 'in 1 h'], [65, 90, 'in 1 h 05'], [0, 30, 'now'],
    [-5, 30, 'started 5 min ago'], [-60, -1, 'ended'], [60 * 26, 60 * 27, 'in 1 d'],
  ])('start %i min, end %i min -> %s', (s, e, want) => {
    expect(relativeStart(now, at(s), at(e))).toBe(want)
  })
  it('formats clock time in a zone', () => {
    expect(clock(now, 'Europe/Rome')).toBe('14:20')
    expect(clock(now, 'Africa/Tripoli')).toBe('15:20')
    expect(clock(now, 'Not/AZone')).toBe('13:20')
  })
})
