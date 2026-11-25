// Allow-list proxy between the glasses app and Google / the LLM provider.
// The app never sees OAuth tokens or the LLM key. Only these routes exist:
//   GET  /gmail/v1/users/me/messages            (q, maxResults<=20, pageToken)
//   GET  /gmail/v1/users/me/messages/:id        (forced format=metadata; From/Subject/Date/To headers)
//   POST /gmail/v1/users/me/drafts              ({ message: { raw, threadId? } } only)
//   GET  /calendar/v3/calendars/:id/events      (timeMin, timeMax, singleEvents, orderBy, maxResults<=20)
//   POST /llm/v1/chat/completions               (model allow-list, <=4 messages, <=8000 chars, max_tokens<=200)
//   GET  /glance/drafts                         (v0.4: app-created drafts that still exist; To/Subject only)
//   POST /glance/drafts/discard                 (v0.4: { ids } -> delete ONLY ledger ids; anything else 403)
// Gmail search `q` must match a small grammar (unread/inbox/category, from:/to: addresses, OR, (), newer_than<=30d).
// Anything else (including every Gmail send path) -> 404. Deleting a draft is not sending.
import { SCOPES, type GoogleOAuth } from './google.ts'
import type { Account, TokenStore } from './store.ts'

export const GMAIL = 'https://gmail.googleapis.com'
export const GCAL = 'https://www.googleapis.com'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  models: string[]
}

export interface ProxyResult { status: number; body: unknown }

export class ProxyError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const CAL_ID = /^(primary|[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,128})$/
const META_HEADERS = new Set(['From', 'Subject', 'Date', 'To'])
export const LEDGER_MAX = 200
export const DRAFTS_LIST_MAX = 20

const Q_TOKEN = /^(is:unread|in:inbox|category:primary|OR|\(|\)|newer_than:([1-9]|[12]\d|30)d|(from|to):[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24})$/
/** Allow-listed Gmail search grammar: no free-text search over the mailbox. */
export function safeQuery(v: string): string | null {
  if (v.length > 400) return null
  const tokens = v.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length || !tokens.every(t => Q_TOKEN.test(t))) return null
  let depth = 0
  for (const t of tokens) { depth += t === '(' ? 1 : t === ')' ? -1 : 0; if (depth < 0 || depth > 2) return null }
  return depth === 0 ? v : null
}

function pick(q: URLSearchParams, allowed: Record<string, (v: string) => string | null>): URLSearchParams {
  const out = new URLSearchParams()
  for (const [k, v] of q) {
    const f = allowed[k]
    if (!f) throw new ProxyError(400, `query parameter not allowed: ${k}`)
    const ok = f(v)
    if (ok === null) throw new ProxyError(400, `bad value for ${k}`)
    out.append(k, ok)
  }
  return out
}
const clampInt = (max: number) => (v: string) => (/^\d{1,4}$/.test(v) ? String(Math.min(Number(v), max)) : null)
const short = (n: number) => (v: string) => (v.length <= n ? v : null)
const isoTime = (v: string) => (!Number.isNaN(Date.parse(v)) && v.length <= 40 ? v : null)
const oneOf = (...xs: string[]) => (v: string) => (xs.includes(v) ? v : null)

export class Proxy {
  private store: TokenStore
  private oauth: GoogleOAuth
  private llm: LlmConfig | undefined
  private fetchImpl: typeof fetch
  private now: () => number
  constructor(store: TokenStore, oauth: GoogleOAuth, llm: LlmConfig | undefined, fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now) {
    this.store = store; this.oauth = oauth; this.llm = llm; this.fetchImpl = fetchImpl; this.now = now
  }

  private async accessToken(acc: Account, force = false): Promise<string> {
    if (!force && acc.accessToken && (acc.accessExpiresAt ?? 0) > this.now() + 60_000) return acc.accessToken
    const t = await this.oauth.refresh(acc.refreshToken)
    acc.accessToken = t.accessToken
    acc.accessExpiresAt = t.expiresAt
    if (t.refreshToken) acc.refreshToken = t.refreshToken
    if (t.scopes.length) acc.scopes = t.scopes
    await this.store.putAccount(acc)
    return t.accessToken
  }

  private async google(acc: Account, url: string, init: RequestInit = {}): Promise<ProxyResult> {
    let token = await this.accessToken(acc)
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}`, accept: 'application/json' } })
      if (r.status === 401 && attempt === 0) { token = await this.accessToken(acc, true); continue }
      const body = await r.json().catch(() => ({}))
      return { status: r.status, body: r.ok ? body : { error: `upstream HTTP ${r.status}` } }
    }
  }

  /** Route a request for an authenticated account. `path` excludes the query string. */
  async handle(acc: Account, method: string, path: string, query: URLSearchParams, body: unknown): Promise<ProxyResult> {
    let m: RegExpMatchArray | null
    if (method === 'GET' && path === '/gmail/v1/users/me/messages') {
      const q = pick(query, { q: safeQuery, maxResults: clampInt(20), pageToken: short(200) })
      return this.google(acc, `${GMAIL}${path}?${q}`)
    }
    if (method === 'GET' && (m = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1])
      if (!ID.test(id)) throw new ProxyError(400, 'bad message id')
      const q = new URLSearchParams({ format: 'metadata' })
      for (const [k, v] of query) {
        if (k === 'format' && v === 'metadata') continue
        if (k === 'metadataHeaders' && META_HEADERS.has(v)) { q.append(k, v); continue }
        throw new ProxyError(400, `query parameter not allowed: ${k}=${v}`)
      }
      return this.google(acc, `${GMAIL}/gmail/v1/users/me/messages/${id}?${q}`)
    }
    if (method === 'POST' && path === '/gmail/v1/users/me/drafts') {
      if (!acc.scopes.includes(SCOPES[1])) throw new ProxyError(403, 'gmail.compose was not granted at sign-in')
      const msg = (body as { message?: { raw?: unknown; threadId?: unknown } })?.message
      const keys = Object.keys((body as object) ?? {})
      if (keys.length !== 1 || !msg || typeof msg.raw !== 'string' || !/^[A-Za-z0-9_-]{1,65536}$/.test(msg.raw)) throw new ProxyError(400, 'expected { message: { raw } }')
      if (msg.threadId !== undefined && (typeof msg.threadId !== 'string' || !ID.test(msg.threadId))) throw new ProxyError(400, 'bad threadId')
      const out = { message: { raw: msg.raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) } }
      const r = await this.google(acc, `${GMAIL}/gmail/v1/users/me/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) })
      // Return only the draft id: the app needs nothing else.
      const id = (r.body as { id?: string })?.id
      if (r.status < 300 && typeof id === 'string' && ID.test(id)) {
        // Remember that WE made this draft (the only drafts the reminder may list or discard).
        acc.appDrafts = [...(acc.appDrafts ?? []).filter(d => d.id !== id), { id, createdAt: this.now() }].slice(-LEDGER_MAX)
        await this.store.putAccount(acc)
      }
      return r.status < 300 ? { status: r.status, body: { id } } : r
    }
    if (method === 'GET' && path === '/glance/drafts') return this.listDrafts(acc)
    if (method === 'POST' && path === '/glance/drafts/discard') return this.discardDrafts(acc, body)
    if (method === 'GET' && (m = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/))) {
      const cal = decodeURIComponent(m[1])
      if (!CAL_ID.test(cal)) throw new ProxyError(400, 'bad calendar id')
      const q = pick(query, { timeMin: isoTime, timeMax: isoTime, singleEvents: oneOf('true', 'false'), orderBy: oneOf('startTime', 'updated'), maxResults: clampInt(20) })
      return this.google(acc, `${GCAL}/calendar/v3/calendars/${encodeURIComponent(cal)}/events?${q}`)
    }
    if (method === 'POST' && path === '/llm/v1/chat/completions') return this.chat(body)
    throw new ProxyError(404, 'not found')
  }

  /** App-created drafts that still exist. A 404 means the user sent or deleted it: drop it from the ledger. */
  private async listDrafts(acc: Account): Promise<ProxyResult> {
    const ledger = [...(acc.appDrafts ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, DRAFTS_LIST_MAX)
    const gone = new Set<string>()
    const drafts: { id: string; to: string; subject: string; createdAt: number }[] = []
    for (const d of ledger) {
      const r = await this.google(acc, `${GMAIL}/gmail/v1/users/me/drafts/${d.id}?format=metadata`)
      if (r.status === 404) { gone.add(d.id); continue }
      if (r.status >= 300) return { status: 502, body: { error: `drafts: upstream HTTP ${r.status}` } }
      const headers = (r.body as { message?: { payload?: { headers?: { name?: string; value?: string }[] } } })?.message?.payload?.headers ?? []
      const h = (n: string) => String(headers.find(x => x.name?.toLowerCase() === n)?.value ?? '').slice(0, 200)
      drafts.push({ id: d.id, to: h('to'), subject: h('subject'), createdAt: d.createdAt })
    }
    if (gone.size) { acc.appDrafts = (acc.appDrafts ?? []).filter(d => !gone.has(d.id)); await this.store.putAccount(acc) }
    return { status: 200, body: { drafts } }
  }

  /** Delete ONLY drafts from this account's ledger. One foreign id -> 403 and nothing is deleted. */
  private async discardDrafts(acc: Account, body: unknown): Promise<ProxyResult> {
    if (!acc.scopes.includes(SCOPES[1])) throw new ProxyError(403, 'gmail.compose was not granted at sign-in')
    const b = body as { ids?: unknown }
    const keys = Object.keys((body as object) ?? {})
    const ids = Array.isArray(b?.ids) ? b.ids : null
    if (keys.length !== 1 || !ids || !ids.length || ids.length > DRAFTS_LIST_MAX || !ids.every(x => typeof x === 'string' && ID.test(x)))
      throw new ProxyError(400, 'expected { ids: [draftId, ...] } (1-20)')
    const mine = new Set((acc.appDrafts ?? []).map(d => d.id))
    if (!ids.every(id => mine.has(id as string))) throw new ProxyError(403, 'only drafts created by Glance Brief can be discarded')
    let discarded = 0
    const removed = new Set<string>()
    for (const id of new Set(ids as string[])) {
      const r = await this.google(acc, `${GMAIL}/gmail/v1/users/me/drafts/${id}`, { method: 'DELETE' })
      if (r.status < 300) { discarded++; removed.add(id) } else if (r.status === 404) removed.add(id)
    }
    acc.appDrafts = (acc.appDrafts ?? []).filter(d => !removed.has(d.id))
    await this.store.putAccount(acc)
    return { status: 200, body: { discarded } }
  }

  private async chat(body: unknown): Promise<ProxyResult> {
    if (!this.llm) throw new ProxyError(503, 'no LLM configured on the backend')
    const b = body as { model?: unknown; messages?: unknown; max_tokens?: unknown; temperature?: unknown }
    const model = typeof b?.model === 'string' && this.llm.models.includes(b.model) ? b.model : null
    if (!model) throw new ProxyError(400, 'model not allowed')
    const msgs = Array.isArray(b.messages) ? b.messages : []
    if (!msgs.length || msgs.length > 4) throw new ProxyError(400, '1-4 messages expected')
    let chars = 0
    const clean = msgs.map(x => {
      const role = (x as { role?: unknown })?.role
      const content = (x as { content?: unknown })?.content
      if ((role !== 'system' && role !== 'user') || typeof content !== 'string') throw new ProxyError(400, 'messages must be {role: system|user, content: string}')
      chars += content.length
      return { role, content }
    })
    if (chars > 8000) throw new ProxyError(413, 'prompt too long')
    const maxTokens = Math.min(Math.max(Number(b.max_tokens) || 60, 1), 200)
    const temperature = Math.min(Math.max(Number(b.temperature) || 0, 0), 1)
    const r = await this.fetchImpl(`${this.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.llm.apiKey}` },
      body: JSON.stringify({ model, messages: clean, max_tokens: maxTokens, temperature }),
    })
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: unknown } }[] }
    if (!r.ok) return { status: 502, body: { error: `LLM HTTP ${r.status}` } }
    const content = j.choices?.[0]?.message?.content
    return { status: 200, body: { choices: [{ message: { content: typeof content === 'string' ? content : '' } }] } }
  }
}
