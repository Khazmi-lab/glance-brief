// HTTP layer (node:http, no framework). Routes:
//   GET  /healthz
//   POST /pair/start                 glasses app: new pairing code (rate limited per IP)
//   POST /pair/poll  {pollSecret}    glasses app: device token once approved
//   POST /pair/revoke (Bearer)       glasses app: unpair; account tokens deleted with the last device
//   GET  /pair, POST /pair (form)    phone/laptop: enter code -> redirect to Google consent
//   GET  /oauth/callback             Google redirect: store tokens, approve pairing
//   POST /stt/v1/transcribe (Bearer)  glasses app: dictation PCM -> text (see stt.ts)
//   Everything else -> allow-list proxy (Bearer device token required).
// Logs never contain tokens, codes, or message content.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { newSecret, sha256 } from './crypto.ts'
import type { GoogleOAuth } from './google.ts'
import { PairingService, RateLimiter } from './pairing.ts'
import { Proxy, ProxyError } from './proxy.ts'
import type { TokenStore } from './store.ts'
import { STT_MAX_BODY, SttError, type SttProxy } from './stt.ts'

export interface Deps {
  store: TokenStore
  pairing: PairingService
  oauth: GoogleOAuth
  proxy: Proxy
  /** Speech-to-text for voice replies; absent -> 503 on /stt/v1/transcribe. */
  stt?: SttProxy
  /** Allowed CORS origins for the WebView; '*' allows any (auth is a Bearer header, no cookies). */
  corsOrigins: string[]
  now?: () => number
  log?: (line: string) => void
}

const MAX_BODY = 128 * 1024

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    // Declared size over the cap: answer 413 without reading (the socket is closed after the reply).
    if (Number(req.headers['content-length'] ?? 0) > max) { reject(new HttpError(413, 'body too large')); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(new HttpError(413, 'body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem}input{letter-spacing:.2em;text-transform:uppercase}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`
}
const PAIR_FORM = (msg = '') => page('Pair Glance Brief', `${msg ? `<p><strong>${esc(msg)}</strong></p>` : ''}
<p>Enter the code shown on your glasses. You will then sign in with Google. Glance Brief reads your inbox and calendar and can only save <em>drafts</em>; it never sends email.</p>
<form method="post" action="/pair"><input name="code" autocomplete="off" maxlength="12" placeholder="ABCD-EF23" required> <button>Continue</button></form>`)

export function createHandler(d: Deps) {
  const now = d.now ?? Date.now
  const log = d.log ?? (() => {})
  const startLimiter = new RateLimiter(20, 10 * 60_000, now)
  const codeLimiter = new RateLimiter(10, 10 * 60_000, now)
  const pollLimiter = new RateLimiter(400, 10 * 60_000, now)
  const apiLimiter = new RateLimiter(120, 60_000, now)

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin
    if (d.corsOrigins.includes('*')) res.setHeader('access-control-allow-origin', '*')
    else if (origin && d.corsOrigins.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin') }
    res.setHeader('access-control-allow-headers', 'authorization, content-type, accept')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  function html(res: ServerResponse, status: number, body: string) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" })
    res.end(body)
  }
  const ip = (req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown'
  const parseJson = (s: string): unknown => { try { return s ? JSON.parse(s) : {} } catch { throw new HttpError(400, 'invalid JSON') } }

  async function device(req: IncomingMessage) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '')
    if (!m) throw new HttpError(401, 'missing device token')
    const dev = await d.store.getDevice(sha256(m[1]))
    if (!dev) throw new HttpError(401, 'unknown or revoked device token')
    return dev
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const path = url.pathname
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: true })

    if (method === 'POST' && path === '/pair/start') {
      if (!startLimiter.allow(ip(req))) throw new HttpError(429, 'too many pairing attempts')
      const p = d.pairing.start()
      return json(res, 200, { ...p, loginPath: '/pair' })
    }
    if (method === 'POST' && path === '/pair/poll') {
      if (!pollLimiter.allow(ip(req))) throw new HttpError(429, 'slow down')
      const b = parseJson(await readBody(req)) as { pollSecret?: unknown }
      if (typeof b.pollSecret !== 'string' || b.pollSecret.length > 200) throw new HttpError(400, 'pollSecret required')
      const r = await d.pairing.poll(b.pollSecret)
      return json(res, r.status === 'expired' ? 410 : 200, r)
    }
    if (method === 'POST' && path === '/pair/revoke') {
      const dev = await device(req)
      await d.store.deleteDevice(dev.tokenHash)
      if (!(await d.store.devicesFor(dev.accountId)).length) await d.store.deleteAccount(dev.accountId)
      log('device revoked')
      return json(res, 200, { ok: true })
    }
    if (method === 'GET' && path === '/pair') return html(res, 200, PAIR_FORM())
    if (method === 'POST' && path === '/pair') {
      if (!codeLimiter.allow(ip(req))) return html(res, 429, PAIR_FORM('Too many attempts. Wait 10 minutes.'))
      const code = new URLSearchParams(await readBody(req)).get('code') ?? ''
      const state = d.pairing.beginLogin(code)
      if (!state) return html(res, 400, PAIR_FORM('That code is not valid or has expired. Check the glasses.'))
      res.writeHead(302, { location: d.oauth.authUrl(state), 'cache-control': 'no-store' })
      res.end(); return
    }
    if (method === 'GET' && path === '/oauth/callback') {
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code')
      if (!d.pairing.hasState(state)) return html(res, 400, PAIR_FORM('This sign-in link expired. Start again with a new code.'))
      if (!code) return html(res, 400, PAIR_FORM(`Google sign-in was cancelled (${url.searchParams.get('error') ?? 'no code'}).`))
      let t
      try { t = await d.oauth.exchange(code) } catch { return html(res, 502, PAIR_FORM('Google sign-in failed. Try again.')) }
      if (!t.refreshToken) return html(res, 400, PAIR_FORM('Google did not return offline access. Try again.'))
      const id = newSecret(12)
      await d.store.putAccount({ id, refreshToken: t.refreshToken, accessToken: t.accessToken, accessExpiresAt: t.expiresAt, scopes: t.scopes, createdAt: now() })
      d.pairing.approve(state, id)
      log('pairing approved')
      return html(res, 200, page('Paired', '<p>Done. Look at your glasses: your brief will load in a few seconds. You can close this page.</p>'))
    }

    // Proxy
    const dev = await device(req)
    if (!apiLimiter.allow(dev.tokenHash)) throw new HttpError(429, 'rate limited')
    const acc = await d.store.getAccount(dev.accountId)
    if (!acc) throw new HttpError(401, 'account removed')
    if (method === 'POST' && path === '/stt/v1/transcribe') {
      if (!d.stt) throw new HttpError(503, 'no speech-to-text configured on the backend')
      const r = await d.stt.transcribe(parseJson(await readBody(req, STT_MAX_BODY)))
      log(`POST /stt/v1/transcribe -> ${r.status} (${r.seconds.toFixed(1)} s audio)`)
      return json(res, r.status, r.body)
    }
    const body = method === 'POST' ? parseJson(await readBody(req)) : undefined
    const r = await d.proxy.handle(acc, method, path, url.searchParams, body)
    log(`${method} ${path.replace(/\/messages\/[^/]+$/, '/messages/:id')} -> ${r.status}`)
    return json(res, r.status, r.body)
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    cors(req, res)
    try { await route(req, res) } catch (e) {
      const status = e instanceof HttpError || e instanceof ProxyError || e instanceof SttError ? e.status : 500
      if (status === 500) log(`error: ${e instanceof Error ? e.message : String(e)}`)
      if (status === 413 && !res.headersSent) res.setHeader('connection', 'close')
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : (e as Error).message })
      else res.end()
    }
  }
}

export function startServer(d: Deps, port: number, host = '127.0.0.1'): Promise<Server> {
  const s = createServer(createHandler(d))
  return new Promise(resolve => s.listen(port, host, () => resolve(s)))
}
