// Gmail API v1 adapters.
// Read: users.messages.list (unread inbox) + users.messages.get (format=metadata).
//   Scope: https://www.googleapis.com/auth/gmail.readonly
// Write: users.drafts.create ONLY (never messages.send). The draft lands in the
//   user's Gmail Drafts for them to review and send. Scope: gmail.compose.
import type { EmailItem, MailSource, ReplySink } from '../core/types'
import type { HttpClient } from './http'

interface GMessage {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name?: string; value?: string }[] }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
}

/** "Anna Rossi <anna@x.it>" -> { name: 'Anna Rossi', address: 'anna@x.it' } */
export function parseFrom(v: string): { name: string; address: string } {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || m[2].trim(), address: m[2].trim() }
  return { name: v.trim(), address: v.trim() }
}

export function parseMessage(body: unknown): EmailItem | null {
  const m = body as GMessage
  if (!m?.id) return null
  const hdr = (n: string) => m.payload?.headers?.find(h => h.name?.toLowerCase() === n)?.value ?? ''
  const from = parseFrom(hdr('from'))
  const ms = Number(m.internalDate)
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    from: from.name,
    fromAddress: from.address,
    subject: hdr('subject').trim(),
    snippet: decodeEntities(m.snippet ?? ''),
    receivedAt: Number.isFinite(ms) ? new Date(ms) : new Date(0),
  }
}

export class GmailSource implements MailSource {
  constructor(private http: HttpClient) {}
  async unread(limit: number): Promise<EmailItem[]> {
    const q = new URLSearchParams({ q: 'is:unread in:inbox category:primary', maxResults: String(limit) })
    const list = (await this.http.getJson(`/gmail/v1/users/me/messages?${q}`)) as { messages?: { id: string }[] }
    const ids = (list.messages ?? []).slice(0, limit).map(m => m.id)
    const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject'
    const msgs = await Promise.all(ids.map(id => this.http.getJson(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${meta}`)))
    return msgs.map(parseMessage).filter((x): x is EmailItem => x !== null).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  }
}

/** RFC 2822 reply body, base64url-encoded as Gmail's drafts.create expects. */
export function buildReplyRaw(to: EmailItem, body: string): string {
  const subject = /^re:/i.test(to.subject) ? to.subject : `Re: ${to.subject}`
  const mime = [
    `To: ${to.fromAddress}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n')
  return base64url(mime)
}

export function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class GmailDraftSink implements ReplySink {
  constructor(private http: HttpClient) {}
  async saveReply(to: EmailItem, body: string) {
    const res = (await this.http.postJson('/gmail/v1/users/me/drafts', {
      message: { threadId: to.threadId, raw: buildReplyRaw(to, body) },
    })) as { id?: string }
    return res?.id
      ? { ok: true, detail: `Draft saved in Gmail (not sent). Reply to ${to.from}.` }
      : { ok: false, detail: 'Gmail did not return a draft id.' }
  }
}
