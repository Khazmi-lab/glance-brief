// Controller: wires sources + summarizer + state machine to a Display.
// The Display is the glasses bridge in production and a fake in tests.
import { buildBrief, composePages, draftsInfo } from './core/brief'
import { initialState, reduce, render, type Effect, type Input, type State } from './core/state'
import type { CalendarSource, DraftTracker, MailSource, Mic, ReplySink, SpeechToText, Summarizer } from './core/types'
import { MIN_BYTES, VoiceBuffer, toBytes } from './core/voice'

export interface Display {
  show(text: string): Promise<void> | void
  exit(): Promise<void> | void
}

export interface AppDeps {
  calendar: CalendarSource
  mail: MailSource
  summarizer: Summarizer
  sink: ReplySink
  display: Display
  now: () => Date
  timeZone: string
  demo: boolean
  /** Voice reply (optional): without both, long press shows "voice not available". */
  mic?: Mic
  stt?: SpeechToText
  /** Pending-drafts reminder (optional): tracks only drafts this app created. */
  drafts?: DraftTracker
}

export class GlanceApp {
  state: State = initialState([])
  private card: Awaited<ReturnType<typeof buildBrief>> | null = null
  private queue: Promise<void> = Promise.resolve()
  readonly voice = new VoiceBuffer()
  private d: AppDeps
  constructor(d: AppDeps) { this.d = d }

  /** Raw mic frame from the bridge (not queued: frames arrive every ~100 ms). */
  pushAudio(pcm: unknown): void {
    if (!this.voice.recording) return
    if (this.voice.push(toBytes(pcm))) void this.dispatch({ type: 'voice_limit' })
  }

  async load(): Promise<void> {
    const now = this.d.now()
    this.card = await buildBrief(this.d.calendar, this.d.mail, this.d.summarizer, { now, timeZone: this.d.timeZone, demo: this.d.demo, drafts: this.d.drafts })
    this.state = initialState(composePages(this.card, { now, timeZone: this.d.timeZone }))
    await this.d.display.show(render(this.state))
  }

  /** Re-read the app-created drafts and rebuild the pages (keeps the current page where possible). */
  private async refreshDrafts(): Promise<void> {
    if (!this.card || !this.d.drafts) return
    const now = this.d.now()
    const before = this.state.pages[this.state.index]
    const errors: string[] = []
    const info = await draftsInfo(this.d.drafts, this.d.calendar, { now, timeZone: this.d.timeZone }, this.card.meeting, !!this.card.backToBack, errors)
    // Keep the drafts card where it was; only its numbers change.
    this.card.drafts = { ...info, moment: this.card.drafts?.moment === 'later' || info.list.length === 0 ? 'later' : this.card.drafts?.moment ?? 'later' }
    const pages = composePages(this.card, { now, timeZone: this.d.timeZone })
    let index = pages.findIndex(p => p.kind === before?.kind && p.emailIndex === before?.emailIndex)
    if (index < 0) index = Math.min(this.state.index, pages.length - 1)
    this.state = { ...this.state, pages, index }
  }

  /** Serialise inputs so async effects can't interleave. */
  dispatch(input: Input): Promise<void> {
    this.queue = this.queue.then(() => this.step(input))
    return this.queue
  }

  private async step(input: Input): Promise<void> {
    const before = render(this.state)
    const { state, effects } = reduce(this.state, input)
    this.state = state
    const after = render(this.state)
    if (after !== before) await this.d.display.show(after)
    for (const e of effects) await this.run(e)
  }

  private async run(e: Effect): Promise<void> {
    if (e.type === 'exit') { await this.d.display.exit(); return }
    if (e.type === 'discard_drafts') {
      let detail: string
      let ok = false
      try {
        const n = await this.d.drafts!.discard(e.ids)
        ok = true
        detail = `Discarded ${n} old ${n === 1 ? 'draft' : 'drafts'} (only ones Glance Brief made). Nothing sent.`
      } catch (err) {
        detail = `Not discarded: ${err instanceof Error ? err.message : String(err)}`
      }
      await this.refreshDrafts()
      await this.step({ type: 'discard_done', ok, detail })
      return
    }
    if (e.type === 'start_mic') {
      if (!this.d.mic || !this.d.stt) { await this.step({ type: 'mic_failed', reason: 'voice not configured' }); return }
      this.voice.start()
      let ok = false
      try { ok = await this.d.mic.open() } catch { ok = false }
      if (!ok) { this.voice.discard(); await this.step({ type: 'mic_failed', reason: 'could not open the microphone' }) }
      return
    }
    if (e.type === 'stop_mic') {
      try { await this.d.mic?.close() } catch { /* closing is best effort */ }
      if (!e.transcribe) { this.voice.discard(); return }
      const pcm = this.voice.stop()
      if (pcm.length < MIN_BYTES) { await this.step({ type: 'voice_failed', reason: 'too short. Hold while you speak.' }); return }
      try {
        const text = await this.d.stt!.transcribe(pcm)
        await this.step({ type: 'voice_text', text })
      } catch (err) {
        await this.step({ type: 'voice_failed', reason: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    const item = this.card?.emails[e.emailIndex]?.item
    if (!item) return
    if (e.type === 'polish_reply') {
      try {
        const body = await this.d.summarizer.polishReply(item, e.said)
        await this.step(body ? { type: 'draft_ready', body } : { type: 'draft_failed', reason: 'empty reply' })
      } catch (err) {
        await this.step({ type: 'draft_failed', reason: err instanceof Error ? err.message : String(err) })
      }
    } else if (e.type === 'request_draft') {
      try {
        const body = await this.d.summarizer.replyDraft(item)
        await this.step({ type: 'draft_ready', body })
      } catch (err) {
        await this.step({ type: 'draft_failed', reason: err instanceof Error ? err.message : String(err) })
      }
    } else if (e.type === 'save_reply') {
      try {
        const r = await this.d.sink.saveReply(item, e.body)
        let detail = r.detail
        if (r.ok && this.d.drafts) {
          this.d.drafts.noteSaved?.(item, r.draftId, this.d.now())
          const n = await this.d.drafts.pending().then(l => l.length).catch(() => 0)
          if (n > 0) detail += ` ${n} waiting in Drafts.`
          await this.refreshDrafts()
        }
        await this.step({ type: 'save_done', ok: r.ok, detail })
      } catch (err) {
        await this.step({ type: 'save_done', ok: false, detail: `Not saved: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
  }
}
