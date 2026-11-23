// Text fitting for the G2 576x288 monochrome text container.
//
// The firmware font is proportional; we budget conservatively by characters.
// LINE_CHARS / MAX_LINES were checked against simulator 0.9.5 screenshots
// (see README "Display budget").

export const DISPLAY_WIDTH = 576
export const DISPLAY_HEIGHT = 288
export const MAX_LINES = 6
export const LINE_CHARS = 40

// The G2 font has no proper U+2026 glyph (renders like ",." in the simulator), so use ASCII.
export const ELLIPSIS = '...'

// Pixel budget measured on simulator 0.9.5 (calibration screenshot, 23 Nov 2026):
// one line held ~35 'W'/'M', ~34 'm', ~51 'a', ~50 digits, 62 chars of mixed prose
// across ~565 px. Coarse per-class widths below over-estimate slightly on purpose.
export const LINE_PX = 560
export function estimatePx(s: string): number {
  let px = 0
  for (const ch of s) {
    if (' .,:;\'!|()[]ijlItf'.includes(ch)) px += 6
    else if ('MWmw@%'.includes(ch)) px += 16.5
    else if (ch >= 'A' && ch <= 'Z') px += 13
    else px += 11.5
  }
  return px
}

/** Shorten a line (with ellipsis) until its estimated width fits LINE_PX. */
export function fitPx(line: string, budget = LINE_PX): string {
  if (estimatePx(line) <= budget) return line
  let n = line.length
  let out = line
  while (n > 1 && estimatePx(out) > budget) { n--; out = truncate(line, n) }
  return out
}

/** Collapse whitespace and strip characters the glasses font may not render. */
export function clean(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut to at most `max` characters, ending in an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  const c = clean(s)
  if (c.length <= max) return c
  if (max <= ELLIPSIS.length) return c.slice(0, max)
  const keep = max - ELLIPSIS.length
  const cut = c.slice(0, keep)
  const sp = cut.lastIndexOf(' ')
  // Keep the last word if it ends exactly at the cut (next char is a space).
  const base = c[keep] === ' ' ? cut : sp >= Math.floor(max / 2) ? cut.slice(0, sp) : cut
  return base.replace(/[\s,.;:–-]+$/, '') + ELLIPSIS
}

/** Keep at most `n` words, adding an ellipsis when words were dropped. */
export function limitWords(s: string, n: number): string {
  const words = clean(s).split(' ').filter(Boolean)
  if (words.length <= n) return words.join(' ')
  return words.slice(0, n).join(' ').replace(/[,.;:–-]+$/, '') + ELLIPSIS
}

/** Greedy word wrap; words longer than a line are hard-split. */
export function wrap(s: string, width = LINE_CHARS): string[] {
  const words = clean(s).split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > width) {
      if (cur) { lines.push(cur); cur = '' }
      lines.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!w) continue
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

/** Wrap and clamp to `maxLines`, ellipsising the last kept line if text was dropped. */
export function wrapClamp(s: string, maxLines: number, width = LINE_CHARS): string[] {
  const lines = wrap(s, width)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = truncate(kept[maxLines - 1] + ' ' + lines[maxLines], width)
  if (!kept[maxLines - 1].endsWith(ELLIPSIS)) kept[maxLines - 1] = truncate(kept[maxLines - 1], width - ELLIPSIS.length) + ELLIPSIS
  return kept
}

/** Join two parts on one line: left text, right-aligned tag (both fitted). */
// The glasses renderer collapses runs of spaces (seen in the simulator), so we
// join with a visible separator instead of padding to right-align.
export function leftRight(left: string, right: string, width = LINE_CHARS): string {
  const r = clean(right)
  const sep = ' · '
  const l = truncate(left, Math.max(1, width - r.length - sep.length))
  return l + sep + r
}
