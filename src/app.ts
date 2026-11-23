// Controller: wires sources + summarizer + state machine to a Display.
// The Display is the glasses bridge in production and a fake in tests.
import { buildBrief, composePages } from './core/brief'
import { initialState, reduce, render, type Effect, type Input, type State } from './core/state'
import type { CalendarSource, MailSource, ReplySink, Summarizer } from './core/types'

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
}

export class GlanceApp {
  state: State = initialState([])
  private card: Awaited<ReturnType<typeof buildBrief>> | null = null
  private queue: Promise<void> = Promise.resolve()
  constructor(private d: AppDeps) {}

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
    const item = this.card?.emails[e.emailIndex]?.item
    if (!item) return
    if (e.type === 'request_draft') {
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
