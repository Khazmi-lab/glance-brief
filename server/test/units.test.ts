import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_ALPHABET, newPairingCode, normaliseCode, sha256 } from '../src/crypto.ts'
import { GoogleOAuth, SCOPES } from '../src/google.ts'
import { PairingService, RateLimiter } from '../src/pairing.ts'
import { EncryptedFileStore, MemoryStore, decrypt, encrypt, parseKey } from '../src/store.ts'
import { fakeUpstream } from './fake-google.ts'

describe('pairing codes', () => {
  it('are XXXX-XXXX from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = newPairingCode()
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      for (const ch of c.replace('-', '')) expect(CODE_ALPHABET).toContain(ch)
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/)
  })
  it('normalise typed input and reject garbage', () => {
    expect(normaliseCode(' abcd ef23 ')).toBe('ABCD-EF23')
    expect(normaliseCode('abcd-ef23')).toBe('ABCD-EF23')
    expect(normaliseCode('ABCD-EF2')).toBe('')
    expect(normaliseCode('ABCD-EF2O')).toBe('') // O is not in the alphabet
    expect(normaliseCode('<script>')).toBe('')
  })
})

describe('PairingService', () => {
  it('issues a device token exactly once after approval and stores only its hash', async () => {
    const store = new MemoryStore()
    const ps = new PairingService(store)
    const s = ps.start()
    expect(await ps.poll(s.pollSecret)).toMatchObject({ status: 'pending' })
    const state = ps.beginLogin(s.code.toLowerCase())!
    expect(state).toBeTruthy()
    expect(ps.approve(state, 'acc1')).toBe(true)
    expect(ps.approve(state, 'acc1')).toBe(false) // state is single use
    const r = await ps.poll(s.pollSecret)
    expect(r.status).toBe('approved')
    const token = (r as { deviceToken: string }).deviceToken
    expect((await store.getDevice(sha256(token)))?.accountId).toBe('acc1')
    expect(await store.getDevice(token)).toBeUndefined()
    expect(await ps.poll(s.pollSecret)).toEqual({ status: 'expired' }) // second poll gets nothing
    expect(ps.beginLogin(s.code)).toBeNull() // code is gone
  })
  it('expires codes after the TTL', async () => {
    let t = 1_000_000
    const ps = new PairingService(new MemoryStore(), () => t, 60_000)
    const s = ps.start()
    t += 61_000
    expect(ps.beginLogin(s.code)).toBeNull()
    expect(await ps.poll(s.pollSecret)).toEqual({ status: 'expired' })
  })
  it('rejects unknown codes, poll secrets and states', async () => {
    const ps = new PairingService(new MemoryStore())
    ps.start()
    expect(ps.beginLogin('AAAA-AAAA')).toBeNull()
    expect(await ps.poll('nope')).toEqual({ status: 'expired' })
    expect(ps.hasState('nope')).toBe(false)
    expect(ps.approve('nope', 'x')).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('allows max hits per window then resets', () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t)
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a'), rl.allow('b')]).toEqual([true, true, false, true])
    t = 1001
    expect(rl.allow('a')).toBe(true)
  })
})

describe('token stores', () => {
  const key = parseKey(Buffer.alloc(32, 7).toString('base64'))
  it('AES-GCM round-trips and detects tampering', () => {
    const blob = encrypt(key, 'secret refresh token')
    expect(blob).not.toContain('secret')
    expect(decrypt(key, blob)).toBe('secret refresh token')
    const j = JSON.parse(blob); j.data = Buffer.from('x' + Buffer.from(j.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64')
    expect(() => decrypt(key, JSON.stringify(j))).toThrow()
    expect(() => decrypt(parseKey(Buffer.alloc(32, 8).toString('base64')), blob)).toThrow()
  })
  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseKey(undefined)).toThrow(/32 bytes/)
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
  it('EncryptedFileStore persists across instances and never writes plaintext', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gb-')), 'store.json')
    const a = new EncryptedFileStore(file, key)
    await a.putAccount({ id: 'acc1', refreshToken: 'refresh-PLAINTEXT', scopes: [...SCOPES], createdAt: 1 })
    await a.putDevice({ tokenHash: 'h1', accountId: 'acc1', createdAt: 1 })
    expect(readFileSync(file, 'utf8')).not.toContain('PLAINTEXT')
    const b = new EncryptedFileStore(file, key)
    expect((await b.getAccount('acc1'))?.refreshToken).toBe('refresh-PLAINTEXT')
    expect(await b.devicesFor('acc1')).toHaveLength(1)
    await b.deleteDevice('h1'); await b.deleteAccount('acc1')
    expect(await new EncryptedFileStore(file, key).getAccount('acc1')).toBeUndefined()
  })
  it('MemoryStore returns copies (callers cannot mutate stored state by accident)', async () => {
    const s = new MemoryStore()
    await s.putAccount({ id: 'a', refreshToken: 'r', scopes: [], createdAt: 0 })
    const got = (await s.getAccount('a'))!
    got.refreshToken = 'changed'
    expect((await s.getAccount('a'))!.refreshToken).toBe('r')
  })
})

describe('GoogleOAuth', () => {
  it('builds a consent URL with read-only Gmail/Calendar + compose and offline access', () => {
    const o = new GoogleOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://b.example/oauth/callback' })
    const u = new URL(o.authUrl('st'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
    ])
    expect(u.searchParams.get('scope')).not.toMatch(/mail\.google\.com|gmail\.send|gmail\.modify|calendar(\.events)?($| )/)
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('state')).toBe('st')
    expect(u.searchParams.get('redirect_uri')).toBe('https://b.example/oauth/callback')
  })
  it('exchanges and refreshes against the token endpoint (mocked)', async () => {
    const up = fakeUpstream()
    const o = new GoogleOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: 'r' }, up.impl, () => 0)
    const t = await o.exchange('GOOD-AUTH-CODE')
    expect(t).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 3599_000 })
    expect(t.scopes).toHaveLength(3)
    expect((await o.refresh('refresh-1')).accessToken).toBe('access-2')
    await expect(o.exchange('bad')).rejects.toThrow(/HTTP 400 invalid_grant/)
    const sent = new URLSearchParams(up.calls[0].body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('client_secret')).toBe('s')
  })
})
