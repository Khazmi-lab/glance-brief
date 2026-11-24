import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { GoogleOAuth } from '../src/google.ts'
import { PairingService } from '../src/pairing.ts'
import { Proxy } from '../src/proxy.ts'
import { startServer } from '../src/server.ts'
import { MemoryStore, type TokenStore } from '../src/store.ts'
import { fakeUpstream } from './fake-google.ts'

export async function boot(opts: Parameters<typeof fakeUpstream>[0] & { llm?: boolean; store?: TokenStore; cors?: string[] } = {}) {
  const up = fakeUpstream(opts)
  const store = opts.store ?? new MemoryStore()
  const oauth = new GoogleOAuth({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', redirectUri: 'http://127.0.0.1/oauth/callback' }, up.impl)
  const logs: string[] = []
  const server: Server = await startServer({
    store, oauth, pairing: new PairingService(store),
    proxy: new Proxy(store, oauth, opts.llm === false ? undefined : { baseUrl: 'https://llm.test/v1', apiKey: 'llm-key', models: ['test-model'] }, up.impl),
    corsOrigins: opts.cors ?? ['*'], log: l => logs.push(l),
  }, 0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, store, up, logs, close: () => new Promise<void>(r => server.close(() => r())) }
}

/** Simulates the user on a phone: submit the code, follow to Google, come back with an auth code. */
export async function approveOnPhone(base: string, code: string, authCode = 'GOOD-AUTH-CODE') {
  const r = await fetch(`${base}/pair`, { method: 'POST', body: new URLSearchParams({ code }), redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  if (r.status !== 302) return { step: 'form', status: r.status, text: await r.text() }
  const google = new URL(r.headers.get('location')!)
  const state = google.searchParams.get('state')!
  const cb = await fetch(`${base}/oauth/callback?${new URLSearchParams({ code: authCode, state, scope: google.searchParams.get('scope')! })}`)
  return { step: 'callback', status: cb.status, text: await cb.text(), google }
}

export async function pairDevice(base: string) {
  const s = await (await fetch(`${base}/pair/start`, { method: 'POST' })).json() as any
  await approveOnPhone(base, s.code)
  const p = await (await fetch(`${base}/pair/poll`, { method: 'POST', body: JSON.stringify({ pollSecret: s.pollSecret }) })).json() as any
  return p.deviceToken as string
}
