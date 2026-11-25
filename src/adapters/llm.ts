// Summarizer adapters.
// - LlmSummarizer: any OpenAI-compatible /chat/completions endpoint (OpenAI,
//   OpenRouter, or a Claude-compatible gateway) reached through our backend,
//   which holds the key. Outputs are forced to one short line.
// - HeuristicSummarizer: offline fallback (no network), used when no LLM is
//   configured and as the failure path.
import type { EmailItem, Meeting, Summarizer } from '../core/types'
import { clean, limitWords } from '../core/text'
import { heuristicPending } from '../core/context'
import type { HttpClient } from './http'

export class HeuristicSummarizer implements Summarizer {
  async meetingBrief(m: Meeting, maxWords: number) {
    const d = clean(m.description ?? '')
    // First sentence, but merge very short fragments like "Agenda: 1." with what follows.
    let first = ''
    for (const part of d.split(/(?<=[.!?])\s/)) {
      first = first ? `${first} ${part}` : part
      if (first.split(' ').length >= 3) break
    }
    if (first) return limitWords(first, maxWords)
    return limitWords(m.attendees.length ? `With ${m.attendees.join(', ')}` : 'No agenda in the invite.', maxWords)
  }
  async emailSummary(e: EmailItem, maxWords: number) {
    return limitWords(e.snippet || e.subject, maxWords)
  }
  async replyDraft(e: EmailItem) {
    return `Thanks ${e.from.split(' ')[0]}, got it. I will get back to you today.`
  }
  /** Offline: use the dictation as-is (tidied), never adding content. */
  async polishReply(_e: EmailItem, said: string) {
    return tidyDictation(said)
  }
  /** Offline: request-like sentences from each attendee's newest email (see heuristicPending). */
  async pendingItems(_m: Meeting, emails: EmailItem[], max: number) {
    return heuristicPending(emails, max)
  }
}

/** Capitalise, end with punctuation, cap at 40 words. Adds no words. */
export function tidyDictation(said: string): string {
  let t = limitWords(said, 40)
  if (!t) return ''
  t = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(t) ? t : `${t}.`
}

const SYSTEM =
  'You write for a tiny monochrome smart-glasses display. Reply with ONE plain line, no quotes, no emoji, no markdown.'

const SYSTEM_LIST =
  'You write for a tiny monochrome smart-glasses display. Plain short lines only, no markdown, no emoji.'

export function oneLine(s: string): string {
  const line = s.split('\n').find(l => l.trim()) ?? ''
  return clean(line.trim().replace(/^["'`]+|["'`]+$/g, ''))
}

export class LlmSummarizer implements Summarizer {
  constructor(private http: HttpClient, private model: string, private path = '/llm/v1/chat/completions') {}
  private async raw(user: string, maxTokens: number): Promise<string> {
    const res = (await this.http.postJson(this.path, {
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM_LIST }, { role: 'user', content: user }],
    })) as { choices?: { message?: { content?: string } }[] }
    return res?.choices?.[0]?.message?.content ?? ''
  }
  private async ask(user: string, maxTokens: number): Promise<string> {
    const res = (await this.http.postJson(this.path, {
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    })) as { choices?: { message?: { content?: string } }[] }
    const text = oneLine(res?.choices?.[0]?.message?.content ?? '')
    if (!text) throw new Error('empty LLM response')
    return text
  }
  async meetingBrief(m: Meeting, maxWords: number) {
    const u = `In at most ${maxWords} words, what should I know walking into this meeting?\nTitle: ${m.title}\nWith: ${m.attendees.join(', ') || 'n/a'}\nNotes: ${clean(m.description ?? '').slice(0, 1500)}`
    return limitWords(await this.ask(u, 60), maxWords)
  }
  async emailSummary(e: EmailItem, maxWords: number) {
    const u = `Summarise this email in at most ${maxWords} words, say what is asked of me if anything.\nFrom: ${e.from}\nSubject: ${e.subject}\nText: ${e.snippet.slice(0, 1500)}`
    return limitWords(await this.ask(u, 60), maxWords)
  }
  async replyDraft(e: EmailItem) {
    const u = `Draft a short, polite one-sentence reply (max 25 words) to this email. No sign-off.\nFrom: ${e.from}\nSubject: ${e.subject}\nText: ${e.snippet.slice(0, 1500)}`
    return limitWords(await this.ask(u, 80), 25)
  }
  async pendingItems(m: Meeting, emails: EmailItem[], max: number) {
    const mails = emails.slice(0, 5).map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nText: ${clean(e.snippet).slice(0, 300)}`).join('\n')
    const u = `Meeting: ${m.title}\nRecent emails with the attendees:\n${mails}\n\nList at most ${max} open items (things asked of me or still undecided) that matter for this meeting. One per line as "FirstName: item", max 8 words each, only from the emails, no invented facts. If none, reply NONE.`
    const text = await this.raw(u, 120)
    const lines = text.split('\n').map(l => clean(l.replace(/^[-*\d.)\s]+/, '').replace(/^["'`]+|["'`]+$/g, ''))).filter(l => l && !/^none\b/i.test(l))
    return lines.slice(0, max).map(l => limitWords(l, 10))
  }
  async polishReply(e: EmailItem, said: string) {
    const u = `Rewrite my dictated words as a short, polite email reply (max 30 words). Keep my meaning exactly; do not add facts, times, promises or names I did not say. No greeting or sign-off.\nReplying to: ${e.from}, subject "${e.subject}"\nI said: ${clean(said).slice(0, 1000)}`
    return limitWords(await this.ask(u, 100), 30)
  }
}

/** Use the primary summarizer, falling back per call (keeps the glance screen alive). */
export class FallbackSummarizer implements Summarizer {
  constructor(private primary: Summarizer, private fallback: Summarizer) {}
  meetingBrief(m: Meeting, n: number) { return this.primary.meetingBrief(m, n).catch(() => this.fallback.meetingBrief(m, n)) }
  emailSummary(e: EmailItem, n: number) { return this.primary.emailSummary(e, n).catch(() => this.fallback.emailSummary(e, n)) }
  replyDraft(e: EmailItem) { return this.primary.replyDraft(e).catch(() => this.fallback.replyDraft(e)) }
  polishReply(e: EmailItem, said: string) { return this.primary.polishReply(e, said).catch(() => this.fallback.polishReply(e, said)) }
  pendingItems(m: Meeting, emails: EmailItem[], n: number) { return this.primary.pendingItems(m, emails, n).catch(() => this.fallback.pendingItems(m, emails, n)) }
}
