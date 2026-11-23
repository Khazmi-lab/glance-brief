import { describe, expect, it } from 'vitest'
import { LINE_CHARS, LINE_PX, clean, estimatePx, fitPx, leftRight, limitWords, truncate, wrap, wrapClamp } from '../src/core/text'

describe('text fitting', () => {
  it('cleans whitespace, control chars and emoji', () => {
    expect(clean('  hi\t\nthere 🎉 ok\u0007 ')).toBe('hi there ok')
  })
  it('truncates on a word boundary with an ellipsis', () => {
    const t = truncate('The quick brown fox jumps over the lazy dog', 20)
    expect(t.length).toBeLessThanOrEqual(20)
    expect(t.endsWith('...')).toBe(true)
    expect(t).toBe('The quick brown...')
    expect(truncate('The quick brown fox jumps over the lazy dog', 22)).toBe('The quick brown fox...')
    expect(truncate('short', 20)).toBe('short')
  })
  it('limits words', () => {
    expect(limitWords('one two three four', 2)).toBe('one two...')
    expect(limitWords('one two', 5)).toBe('one two')
  })
  it('wraps greedily and hard-splits long words', () => {
    const lines = wrap('a'.repeat(95) + ' bb cc', 40)
    expect(lines).toEqual(['a'.repeat(40), 'a'.repeat(40), 'a'.repeat(15) + ' bb cc'])
    for (const l of wrap('lorem ipsum dolor sit amet '.repeat(10))) expect(l.length).toBeLessThanOrEqual(LINE_CHARS)
  })
  it('clamps wrapped text and marks the cut', () => {
    const lines = wrapClamp('word '.repeat(50), 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith('...')).toBe(true)
    expect(lines[1].length).toBeLessThanOrEqual(LINE_CHARS)
  })
  it('joins header parts with a visible separator within the line width', () => {
    const l = leftRight('INBOX 1/3', '15:20')
    expect(l).toBe('INBOX 1/3 · 15:20')
    expect(leftRight('x'.repeat(80), 'DEMO 15:20').length).toBeLessThanOrEqual(LINE_CHARS)
  })
  it('pixel estimate matches the simulator calibration (35 W overflow, 62 mixed chars fit)', () => {
    expect(estimatePx('W'.repeat(36))).toBeGreaterThan(565)
    expect(estimatePx('a'.repeat(48))).toBeLessThanOrEqual(LINE_PX)
    expect(estimatePx('Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do')).toBeGreaterThan(500)
  })
  it('fitPx shortens wide all-caps lines that pass the char budget', () => {
    const caps = 'WWWWWWWWWW MMMMMMMMMM WWWWWWWWWW MMMMMMM' // 39 chars, ~620 px
    expect(caps.length).toBeLessThanOrEqual(LINE_CHARS)
    const f = fitPx(caps)
    expect(estimatePx(f)).toBeLessThanOrEqual(LINE_PX)
    expect(f.endsWith('...')).toBe(true)
    expect(fitPx('short line')).toBe('short line')
  })
})
