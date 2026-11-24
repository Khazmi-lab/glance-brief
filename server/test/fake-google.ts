// Fake upstreams (TEST DOUBLES): Google OAuth token endpoint, Gmail v1, Calendar v3,
// and an OpenAI-compatible LLM. Records every call so tests can assert what was sent.
import { readFileSync } from 'node:fs'

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${n}`, import.meta.url), 'utf8'))

export interface Call { method: string; url: string; auth?: string; body?: string }

export function fakeUpstream(opts: { expireFirstAccess?: boolean; scope?: string; llmReply?: string } = {}) {
  const calls: Call[] = []
  let issued = 0
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? init.body : undefined
    calls.push({ method: init.method ?? 'GET', url, auth: headers.get('authorization') ?? undefined, body })
    const u = new URL(url)
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(body)
      issued++
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'GOOD-AUTH-CODE') return reply(400, { error: 'invalid_grant' })
        return reply(200, { access_token: `access-${issued}`, expires_in: opts.expireFirstAccess ? 0 : 3599, refresh_token: 'refresh-1', scope: opts.scope ?? 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly', token_type: 'Bearer' })
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-1') return reply(200, { access_token: `access-${issued}`, expires_in: 3599 })
      return reply(400, { error: 'invalid_grant' })
    }
    if (u.host === 'llm.test') {
      if (headers.get('authorization') !== 'Bearer llm-key') return reply(401, {})
      return reply(200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: opts.llmReply ?? 'Confirm budget numbers before 16:00.' } }], usage: { total_tokens: 9 } })
    }
    if (!headers.get('authorization')?.startsWith('Bearer access-')) return reply(401, { error: 'unauthenticated' })
    if (u.host === 'gmail.googleapis.com') {
      if (u.pathname === '/gmail/v1/users/me/messages') return reply(200, fx('gmail_list.json'))
      const m = u.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(a1|a2)$/)
      if (m) return reply(200, fx(`gmail_${m[1]}.json`))
      if (u.pathname === '/gmail/v1/users/me/drafts' && init.method === 'POST') return reply(200, { id: 'r-draft-1', message: { id: 'm9', threadId: 't1', labelIds: ['DRAFT'] } })
      return reply(404, { error: 'not found' })
    }
    if (u.host === 'www.googleapis.com' && u.pathname === '/calendar/v3/calendars/primary/events') return reply(200, fx('calendar_events.json'))
    return reply(404, {})
  }) as typeof fetch
  return { impl, calls }
}
