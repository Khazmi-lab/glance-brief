// v0.4 backend: allow-listed Gmail search grammar, app-created drafts ledger, list + discard.
// Upstream Google is a FAKE (test double). There is still no send route.
import { afterEach, describe, expect, it } from 'vitest'
import { boot, pairDevice } from './harness.ts'
import { safeQuery } from '../src/proxy.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })
async function up(o: Parameters<typeof boot>[0] = {}) { const b = await boot(o); close = b.close; return b }
const get = (base: string, path: string, token: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } })
const post = (base: string, path: string, body: unknown, token: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
const RAW = Buffer.from('To: Sara <sara@example.com>\r\nSubject: Re: Mockups\r\n\r\nok').toString('base64url')

describe('Gmail search grammar (meeting context is read-only and narrow)', () => {
  it('accepts the app queries', () => {
    expect(safeQuery('is:unread in:inbox category:primary')).not.toBeNull()
    expect(safeQuery('(from:marco@example.com OR to:marco@example.com OR from:sara@example.com OR to:sara@example.com) newer_than:14d')).not.toBeNull()
  })
  it('rejects free text, other operators, long windows and unbalanced parentheses', () => {
    for (const q of ['password', 'from:a@b.io has:attachment', 'subject:invoice', 'newer_than:365d', 'newer_than:2y', '(from:a@b.io', 'from:a@b.io)', 'in:anywhere', 'label:secret', '((((from:a@b.io))))', 'x'.repeat(401)])
      expect(safeQuery(q), q).toBeNull()
  })
  it('over HTTP: allowed query is forwarded, anything else is 400 before reaching Google', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    const ok = await get(base, `/gmail/v1/users/me/messages?${new URLSearchParams({ q: '(from:sara@example.com OR to:sara@example.com) newer_than:14d', maxResults: '5' })}`, token)
    expect(ok.status).toBe(200)
    const before = u.calls.length
    expect((await get(base, `/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'bank statement' })}`, token)).status).toBe(400)
    expect(u.calls.length).toBe(before)
  })
})

describe('app-created drafts ledger', () => {
  it('records drafts it creates and lists only those (To/Subject only, never the body)', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    expect((await (await get(base, '/glance/drafts', token)).json() as any).drafts).toEqual([])
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW, threadId: 't1' } }, token)
    const r = await (await get(base, '/glance/drafts', token)).json() as any
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0]).toMatchObject({ id: 'r-draft-1', to: 'Sara <sara@example.com>', subject: 'Re: Mockups' })
    expect(typeof r.drafts[0].createdAt).toBe('number')
    expect(JSON.stringify(r)).not.toContain('SECRET BODY')
    expect(JSON.stringify(r)).not.toContain('user-own-draft') // the user's own draft is never listed
    expect(u.calls.some(c => c.url.includes('/drafts/user-own-draft'))).toBe(false)
  })
  it('a draft the user sent (or deleted) in Gmail drops out of the list and the ledger', async () => {
    const { base, up: u, store } = await up()
    const token = await pairDevice(base)
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW } }, token)
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW } }, token)
    u.drafts.delete('r-draft-1') // "sent from Gmail on the phone"
    const r = await (await get(base, '/glance/drafts', token)).json() as any
    expect(r.drafts.map((d: any) => d.id)).toEqual(['r-draft-2'])
    const acc = Object.values((store as any).data.accounts)[0] as any
    expect(acc.appDrafts.map((d: any) => d.id)).toEqual(['r-draft-2'])
  })
  it('discard deletes ONLY ledger drafts; one foreign id -> 403 and nothing is deleted', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW } }, token)
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW } }, token)
    const before = u.calls.length
    const foreign = await post(base, '/glance/drafts/discard', { ids: ['r-draft-1', 'user-own-draft'] }, token)
    expect(foreign.status).toBe(403)
    expect(u.calls.length).toBe(before)
    expect(u.drafts.has('user-own-draft')).toBe(true)
    expect(u.drafts.has('r-draft-1')).toBe(true)
    const ok = await post(base, '/glance/drafts/discard', { ids: ['r-draft-1'] }, token)
    expect(await ok.json()).toEqual({ discarded: 1 })
    expect(u.calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-draft-1' })
    expect(u.drafts.has('r-draft-1')).toBe(false)
    expect(u.drafts.has('r-draft-2')).toBe(true)
    // Already gone -> 403 now (no longer in the ledger)
    expect((await post(base, '/glance/drafts/discard', { ids: ['r-draft-1'] }, token)).status).toBe(403)
  })
  it('validates the discard body strictly', async () => {
    const { base } = await up()
    const token = await pairDevice(base)
    for (const b of [{}, { ids: [] }, { ids: 'r-draft-1' }, { ids: ['../x'] }, { ids: ['a'], send: true }, { ids: Array.from({ length: 21 }, (_, i) => `d${i}`) }])
      expect((await post(base, '/glance/drafts/discard', b, token)).status, JSON.stringify(b)).toBe(400)
  })
  it('still no way to send or to touch drafts outside the glance routes', async () => {
    const { base, up: u } = await up()
    const token = await pairDevice(base)
    await post(base, '/gmail/v1/users/me/drafts', { message: { raw: RAW } }, token)
    const before = u.calls.length
    expect((await post(base, '/gmail/v1/users/me/drafts/send', { id: 'r-draft-1' }, token)).status).toBe(404)
    expect((await post(base, '/glance/drafts/send', { ids: ['r-draft-1'] }, token)).status).toBe(404)
    expect((await fetch(`${base}/gmail/v1/users/me/drafts/r-draft-1`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect((await get(base, '/gmail/v1/users/me/drafts/r-draft-1', token)).status).toBe(404)
    expect((await get(base, '/gmail/v1/users/me/drafts', token)).status).toBe(404)
    expect(u.calls.length).toBe(before)
  })
  it('discard needs gmail.compose; logs carry no draft ids or subjects', async () => {
    const { base, logs } = await up({ scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly' })
    const token = await pairDevice(base)
    expect((await post(base, '/glance/drafts/discard', { ids: ['r-draft-1'] }, token)).status).toBe(403)
    await get(base, '/glance/drafts', token)
    const all = logs.join('\n')
    expect(all).toContain('GET /glance/drafts -> 200')
    for (const s of ['r-draft', 'Mockups', token]) expect(all).not.toContain(s)
  })
})
