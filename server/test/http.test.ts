import { afterEach, describe, expect, it } from 'vitest'
import { approveOnPhone, boot, pairDevice } from './harness.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })
async function up(o: Parameters<typeof boot>[0] = {}) { const b = await boot(o); close = b.close; return b }
const get = (base: string, path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
const post = (base: string, path: string, body: unknown, token?: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

describe('pairing over HTTP', () => {
  it('serves the pairing page with a strict CSP and no-store', async () => {
    const { base } = await up()
    const r = await get(base, '/pair')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).toContain('never sends email')
  })
  it('full flow: start -> phone enters code -> Google consent -> callback -> poll returns token once', async () => {
    const { base, store } = await up()
    const s = await (await post(base, '/pair/start', {})).json() as any
    expect(s.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(s.loginPath).toBe('/pair')
    expect((await (await post(base, '/pair/poll', { pollSecret: s.pollSecret })).json() as any).status).toBe('pending')
    const phone = await approveOnPhone(base, s.code.replace('-', ' ').toLowerCase())
    expect(phone.step).toBe('callback')
    expect(phone.status).toBe(200)
    expect(phone.google!.origin).toBe('https://accounts.google.com')
    const p = await (await post(base, '/pair/poll', { pollSecret: s.pollSecret })).json() as any
    expect(p.status).toBe('approved')
    expect(p.deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect((await post(base, '/pair/poll', { pollSecret: s.pollSecret })).status).toBe(410)
    expect(await store.getDevice(p.deviceToken)).toBeUndefined() // stored hashed only
  })
  it('wrong code shows the form again; a reused or forged OAuth state is refused', async () => {
    const { base } = await up()
    const bad = await approveOnPhone(base, 'AAAA-AAAA')
    expect(bad).toMatchObject({ step: 'form', status: 400 })
    const s = await (await post(base, '/pair/start', {})).json() as any
    const ok = await approveOnPhone(base, s.code)
    expect(ok.status).toBe(200)
    const replay = await get(base, `/oauth/callback?code=GOOD-AUTH-CODE&state=${ok.google!.searchParams.get('state')}`)
    expect(replay.status).toBe(400)
    expect((await get(base, '/oauth/callback?code=GOOD-AUTH-CODE&state=forged')).status).toBe(400)
  })
  it('a cancelled consent or failed exchange does not pair', async () => {
    const { base } = await up()
    const s = await (await post(base, '/pair/start', {})).json() as any
    const r = await approveOnPhone(base, s.code, 'BAD-CODE')
    expect(r.status).toBe(502)
    expect((await (await post(base, '/pair/poll', { pollSecret: s.pollSecret })).json() as any).status).toBe('pending')
  })
  it('rate limits wrong code entries per IP', async () => {
    const { base } = await up()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await approveOnPhone(base, 'AAAA-AAAA')).status)
    expect(statuses.slice(0, 10).every(s => s === 400)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })
  it('revoke removes the device and, with the last device, the Google tokens', async () => {
    const { base, store } = await up()
    const token = await pairDevice(base)
    expect((await get(base, '/gmail/v1/users/me/messages?maxResults=2', token)).status).toBe(200)
    expect((await post(base, '/pair/revoke', {}, token)).status).toBe(200)
    expect((await get(base, '/gmail/v1/users/me/messages?maxResults=2', token)).status).toBe(401)
    expect((store as unknown as { data: { accounts: object } }).data.accounts).toEqual({})
  })
})

describe('allow-list proxy', () => {
  it('requires a valid device token', async () => {
    const { base } = await up()
    expect((await get(base, '/gmail/v1/users/me/messages')).status).toBe(401)
    expect((await get(base, '/gmail/v1/users/me/messages', 'x'.repeat(43))).status).toBe(401)
  })
  it('forwards Gmail list with the server-side access token and clamps maxResults', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const r = await get(base, '/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=500', token)
    expect(r.status).toBe(200)
    expect((await r.json() as any).messages).toHaveLength(2)
    const call = u.calls.at(-1)!
    expect(call.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=20')
    expect(call.auth).toBe('Bearer access-1')
  })
  it('forces format=metadata on message reads and rejects full/raw bodies', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    expect((await get(base, '/gmail/v1/users/me/messages/a1?format=metadata&metadataHeaders=From', token)).status).toBe(200)
    expect(u.calls.at(-1)!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/a1?format=metadata&metadataHeaders=From')
    expect((await get(base, '/gmail/v1/users/me/messages/a1?format=full', token)).status).toBe(400)
    expect((await get(base, '/gmail/v1/users/me/messages/a1?format=raw', token)).status).toBe(400)
    expect((await get(base, '/gmail/v1/users/me/messages/..%2Fsettings', token)).status).toBe(400)
  })
  it('never exposes a send path', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const before = u.calls.length
    for (const p of ['/gmail/v1/users/me/messages/send', '/gmail/v1/users/me/drafts/send', '/gmail/v1/users/me/messages/a1/modify', '/gmail/v1/users/me/messages/a1/trash'])
      expect((await post(base, p, { raw: 'eA' }, token)).status).toBe(404)
    expect((await fetch(`${base}/gmail/v1/users/me/messages/a1`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect(u.calls.length).toBe(before) // nothing reached Google
  })
  it('drafts.create passes only { message: { raw, threadId } } and returns only the id', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const r = await post(base, '/gmail/v1/users/me/drafts', { message: { raw: 'VG86IGFAYi5jb20', threadId: 't1' } }, token)
    expect(r.status).toBe(200)
    expect(await r.json() as any).toEqual({ id: 'r-draft-1' })
    expect(JSON.parse(u.calls.at(-1)!.body!)).toEqual({ message: { raw: 'VG86IGFAYi5jb20', threadId: 't1' } })
    expect((await post(base, '/gmail/v1/users/me/drafts', { message: { raw: 'VG8' }, send: true }, token)).status).toBe(400)
    expect((await post(base, '/gmail/v1/users/me/drafts', { message: { raw: 'not base64url!' } }, token)).status).toBe(400)
  })
  it('refuses drafts when the user did not grant gmail.compose', async () => {
    const { base } = await up({ scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly' })
    const token = await pairDevice(base)
    const r = await post(base, '/gmail/v1/users/me/drafts', { message: { raw: 'VG8' } }, token)
    expect(r.status).toBe(403)
    expect((await r.json() as any).error).toMatch(/gmail.compose/)
  })
  it('calendar: allow-listed params only', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const ok = await get(base, '/calendar/v3/calendars/primary/events?timeMin=2026-11-23T12%3A00%3A00.000Z&singleEvents=true&orderBy=startTime&maxResults=30', token)
    expect(ok.status).toBe(200)
    expect(u.calls.at(-1)!.url).toContain('maxResults=20')
    expect((await get(base, '/calendar/v3/calendars/primary/events?showDeleted=true', token)).status).toBe(400)
    expect((await get(base, '/calendar/v3/calendars/primary/acl', token)).status).toBe(404)
  })
  it('refreshes an expired access token, and retries once on upstream 401', async () => {
    const { base, up: u } = await up({ expireFirstAccess: true })
    const token = await pairDevice(base)
    expect((await get(base, '/gmail/v1/users/me/messages', token)).status).toBe(200)
    expect(u.calls.filter(c => c.url.includes('/token')).map(c => new URLSearchParams(c.body).get('grant_type'))).toEqual(['authorization_code', 'refresh_token'])
    expect(u.calls.at(-1)!.auth).toBe('Bearer access-2')
  })
  it('LLM: injects the server key, enforces model allow-list and limits, strips extras', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const r = await post(base, '/llm/v1/chat/completions', { model: 'test-model', max_tokens: 5000, temperature: 3, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }, token)
    expect(r.status).toBe(200)
    expect(await r.json() as any).toEqual({ choices: [{ message: { content: 'Confirm budget numbers before 16:00.' } }] })
    const sent = JSON.parse(u.calls.at(-1)!.body!)
    expect(u.calls.at(-1)!.auth).toBe('Bearer llm-key')
    expect(sent).toMatchObject({ model: 'test-model', max_tokens: 200, temperature: 1 })
    expect((await post(base, '/llm/v1/chat/completions', { model: 'gpt-expensive', messages: [{ role: 'user', content: 'u' }] }, token)).status).toBe(400)
    expect((await post(base, '/llm/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(9000) }] }, token)).status).toBe(413)
    expect((await post(base, '/llm/v1/chat/completions', { model: 'test-model', messages: [{ role: 'tool', content: 'x' }] }, token)).status).toBe(400)
  })
  it('LLM off -> 503 so the app falls back to the offline summarizer', async () => {
    const { base } = await up({ llm: false })
    const token = await pairDevice(base)
    expect((await post(base, '/llm/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'u' }] }, token)).status).toBe(503)
  })
  it('CORS: preflight works; configured origins only', async () => {
    const { base } = await up({ cors: ['https://app.example'] })
    const pre = await fetch(`${base}/gmail/v1/users/me/messages`, { method: 'OPTIONS', headers: { origin: 'https://app.example' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')
    const other = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('logs contain no tokens, codes or message content', async () => {
    const { base, logs } = await up()
    const token = await pairDevice(base)
    await get(base, '/gmail/v1/users/me/messages/a1?format=metadata', token)
    await post(base, '/llm/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'PRIVATE-TEXT' }] }, token)
    const all = logs.join('\n')
    expect(all).toContain('/messages/:id -> 200')
    for (const s of [token, 'access-1', 'refresh-1', 'llm-key', 'PRIVATE-TEXT', 'a1']) expect(all).not.toContain(s)
  })
})
