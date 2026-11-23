// Screen state machine. Pure reducer: (state, input) -> { state, effects }.
// Writes happen only through the 'saveReply' effect, which is emitted only from
// the confirm screen after an explicit tap.
import type { Page } from './brief'
import { LINE_CHARS, MAX_LINES, fitPx, truncate, wrapClamp } from './text'

export type Input =
  | { type: 'click' }
  | { type: 'double_click' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'long_press' }
  | { type: 'draft_ready'; body: string }
  | { type: 'draft_failed'; reason: string }
  | { type: 'save_done'; ok: boolean; detail: string }

export type Mode = 'browse' | 'drafting' | 'confirm' | 'saving' | 'result'

export interface State {
  pages: Page[]
  index: number
  mode: Mode
  draft?: string
  resultText?: string
}

export type Effect =
  | { type: 'exit' }
  | { type: 'request_draft'; emailIndex: number }
  | { type: 'save_reply'; emailIndex: number; body: string }

export function initialState(pages: Page[]): State {
  return { pages, index: 0, mode: 'browse' }
}

export function reduce(s: State, input: Input): { state: State; effects: Effect[] } {
  // Double tap always exits, from every mode (platform rule).
  if (input.type === 'double_click') return { state: s, effects: [{ type: 'exit' }] }
  const page = s.pages[s.index]
  switch (s.mode) {
    case 'browse':
      if (input.type === 'down') return { state: { ...s, index: Math.min(s.index + 1, s.pages.length - 1) }, effects: [] }
      if (input.type === 'up') return { state: { ...s, index: Math.max(s.index - 1, 0) }, effects: [] }
      if (input.type === 'click') {
        if (page?.kind === 'email' && page.emailIndex !== undefined)
          return { state: { ...s, mode: 'drafting', draft: undefined }, effects: [{ type: 'request_draft', emailIndex: page.emailIndex }] }
        // Tap on a meeting/notes page jumps to the first email (or stays).
        const first = s.pages.findIndex(p => p.kind === 'email')
        return { state: { ...s, index: first >= 0 ? first : s.index }, effects: [] }
      }
      return { state: s, effects: [] }
    case 'drafting':
      if (input.type === 'draft_ready') return { state: { ...s, mode: 'confirm', draft: input.body }, effects: [] }
      if (input.type === 'draft_failed') return { state: { ...s, mode: 'result', resultText: `Draft failed: ${input.reason}` }, effects: [] }
      if (input.type === 'up' || input.type === 'down') return { state: { ...s, mode: 'browse', draft: undefined }, effects: [] }
      return { state: s, effects: [] }
    case 'confirm':
      if (input.type === 'click' && s.draft && page?.emailIndex !== undefined)
        return { state: { ...s, mode: 'saving' }, effects: [{ type: 'save_reply', emailIndex: page.emailIndex, body: s.draft }] }
      if (input.type === 'up' || input.type === 'down') return { state: { ...s, mode: 'browse', draft: undefined }, effects: [] }
      return { state: s, effects: [] }
    case 'saving':
      if (input.type === 'save_done') return { state: { ...s, mode: 'result', resultText: input.detail }, effects: [] }
      return { state: s, effects: [] }
    case 'result':
      if (input.type === 'click' || input.type === 'up' || input.type === 'down') {
        const next = input.type === 'down' || input.type === 'click' ? Math.min(s.index + 1, s.pages.length - 1) : s.index
        return { state: { ...s, mode: 'browse', index: next, draft: undefined, resultText: undefined }, effects: [] }
      }
      return { state: s, effects: [] }
  }
}

/** Text for the single full-screen container. Always <= MAX_LINES lines of <= LINE_CHARS. */
export function render(s: State): string {
  const page = s.pages[s.index]
  let lines: string[]
  switch (s.mode) {
    case 'browse':
      lines = page ? page.lines : ['GLANCE BRIEF', 'Nothing to show.']
      break
    case 'drafting':
      lines = ['DRAFTING REPLY...', truncate(page?.lines[1] ?? '', LINE_CHARS), '', 'Swipe to cancel.']
      break
    case 'confirm':
      lines = [
        truncate(`REPLY TO ${page?.lines[1] ?? ''}`, LINE_CHARS),
        ...wrapClamp(s.draft ?? '', 3),
        'Tap: SAVE as Gmail draft',
        'Swipe: cancel',
      ]
      break
    case 'saving':
      lines = ['SAVING DRAFT...']
      break
    case 'result':
      lines = ['DONE', ...wrapClamp(s.resultText ?? '', 3), 'Tap or swipe: continue']
      break
  }
  return lines.slice(0, MAX_LINES).map(l => fitPx(truncate(l, LINE_CHARS))).join('\n')
}
