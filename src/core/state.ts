// Screen state machine. Pure reducer: (state, input) -> { state, effects }.
// Writes happen only through the 'saveReply' effect, which is emitted only from
// the confirm screen after an explicit tap. Voice reply (long press on an email):
// listening -> transcribing -> drafting -> the SAME confirm screen; nothing is
// ever sent, and a voice draft is saved only after the same confirm tap.
import type { Page } from './brief'
import { LINE_CHARS, MAX_LINES, fitPx, truncate, wrapClamp } from './text'

export type Input =
  | { type: 'click' }
  | { type: 'double_click' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'long_press' }
  | { type: 'long_press_release' }
  /** Recording hit the length cap (treated like a release). */
  | { type: 'voice_limit' }
  | { type: 'mic_failed'; reason: string }
  | { type: 'voice_text'; text: string }
  | { type: 'voice_failed'; reason: string }
  | { type: 'draft_ready'; body: string }
  | { type: 'draft_failed'; reason: string }
  | { type: 'save_done'; ok: boolean; detail: string }

export type Mode = 'browse' | 'listening' | 'transcribing' | 'drafting' | 'confirm' | 'saving' | 'result'

export interface State {
  pages: Page[]
  index: number
  mode: Mode
  draft?: string
  resultText?: string
  /** Last transcript (voice flow), shown while the reply is being drafted. */
  heard?: string
}

export type Effect =
  | { type: 'exit' }
  | { type: 'request_draft'; emailIndex: number }
  | { type: 'save_reply'; emailIndex: number; body: string }
  | { type: 'start_mic' }
  /** Close the mic; `transcribe` = send the captured audio to STT, else discard it. */
  | { type: 'stop_mic'; transcribe: boolean; emailIndex?: number }
  | { type: 'polish_reply'; emailIndex: number; said: string }

export function initialState(pages: Page[]): State {
  return { pages, index: 0, mode: 'browse' }
}

export function reduce(s: State, input: Input): { state: State; effects: Effect[] } {
  // Double tap always exits, from every mode (platform rule). The mic is closed first.
  if (input.type === 'double_click')
    return { state: s, effects: s.mode === 'listening' ? [{ type: 'stop_mic', transcribe: false }, { type: 'exit' }] : [{ type: 'exit' }] }
  const page = s.pages[s.index]
  const swipe = input.type === 'up' || input.type === 'down'
  // Long press on an email (browsing, or on the confirm screen to re-dictate) starts listening.
  if (input.type === 'long_press' && (s.mode === 'browse' || s.mode === 'confirm') && page?.kind === 'email' && page.emailIndex !== undefined)
    return { state: { ...s, mode: 'listening', draft: undefined, heard: undefined }, effects: [{ type: 'start_mic' }] }
  switch (s.mode) {
    case 'listening':
      if (input.type === 'long_press_release' || input.type === 'voice_limit')
        return { state: { ...s, mode: 'transcribing' }, effects: [{ type: 'stop_mic', transcribe: true, emailIndex: page?.emailIndex }] }
      if (swipe) return { state: { ...s, mode: 'browse' }, effects: [{ type: 'stop_mic', transcribe: false }] }
      if (input.type === 'mic_failed') return { state: { ...s, mode: 'result', resultText: `Mic unavailable: ${input.reason}` }, effects: [] }
      return { state: s, effects: [] }
    case 'transcribing':
      if (input.type === 'voice_text') {
        const said = input.text.trim()
        if (!said) return { state: { ...s, mode: 'result', resultText: "Didn't catch that. Long-press and speak to retry." }, effects: [] }
        if (page?.emailIndex === undefined) return { state: { ...s, mode: 'browse' }, effects: [] }
        return { state: { ...s, mode: 'drafting', heard: said }, effects: [{ type: 'polish_reply', emailIndex: page.emailIndex, said }] }
      }
      if (input.type === 'voice_failed') return { state: { ...s, mode: 'result', resultText: `Voice failed: ${input.reason}` }, effects: [] }
      if (swipe) return { state: { ...s, mode: 'browse' }, effects: [] }
      return { state: s, effects: [] }
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
      if (swipe) return { state: { ...s, mode: 'browse', draft: undefined, heard: undefined }, effects: [] }
      return { state: s, effects: [] }
    case 'confirm':
      if (input.type === 'click' && s.draft && page?.emailIndex !== undefined)
        return { state: { ...s, mode: 'saving' }, effects: [{ type: 'save_reply', emailIndex: page.emailIndex, body: s.draft }] }
      if (swipe) return { state: { ...s, mode: 'browse', draft: undefined, heard: undefined }, effects: [] }
      return { state: s, effects: [] }
    case 'saving':
      if (input.type === 'save_done') return { state: { ...s, mode: 'result', resultText: input.detail }, effects: [] }
      return { state: s, effects: [] }
    case 'result':
      if (input.type === 'click' || input.type === 'up' || input.type === 'down') {
        const next = input.type === 'down' || input.type === 'click' ? Math.min(s.index + 1, s.pages.length - 1) : s.index
        return { state: { ...s, mode: 'browse', index: next, draft: undefined, resultText: undefined, heard: undefined }, effects: [] }
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
    case 'listening':
      lines = ['LISTENING... (max 15 s)', truncate(`Reply to ${page?.lines[1] ?? ''}`, LINE_CHARS), '', 'Speak, then release.', 'Swipe: cancel']
      break
    case 'transcribing':
      lines = ['TRANSCRIBING...', truncate(page?.lines[1] ?? '', LINE_CHARS), '', 'Swipe to cancel.']
      break
    case 'drafting':
      lines = s.heard
        ? ['DRAFTING REPLY...', ...wrapClamp(`Heard: ${s.heard}`, 3), 'Swipe to cancel.']
        : ['DRAFTING REPLY...', truncate(page?.lines[1] ?? '', LINE_CHARS), '', 'Swipe to cancel.']
      break
    case 'confirm':
      lines = [
        truncate(`REPLY TO ${page?.lines[1] ?? ''}`, LINE_CHARS),
        ...wrapClamp(s.draft ?? '', 3),
        'Tap: SAVE as Gmail draft',
        'Swipe: cancel · Hold: speak',
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
