// Controller: wires sources + summarizer + state machine to a Display.
// The Display is the glasses bridge in production and a fake in tests.
import { buildBrief, composePages } from './core/brief'
import { initialState, reduce, render, type Effect, type Input, type State } from './core/state'
import type { CalendarSource, MailSource, Mic, ReplySink, SpeechToText, Summarizer } from './core/types'
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
    this.card = await buildBrief(this.d.calendar, this.d.mail, this.d.summarizer, { now, timeZone: this.d.timeZone, demo: this.d.demo })
    this.state = initialState(composePages(this.card, { now, timeZone: this.d.timeZone }))
    await this.d.display.show(render(this.state))
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
        await this.step({ type: 'save_done', ok: r.ok, detail: r.detail })
      } catch (err) {
        await this.step({ type: 'save_done', ok: false, detail: `Not saved: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
  }
}
