// Google OAuth 2.0 (web server flow) for the pairing page. Scopes are the minimum
// Glance Brief needs:
//   gmail.readonly    - list unread + read message metadata
//   gmail.compose     - create drafts (Google has no drafts-only scope; this scope
//                       could also send, so the proxy allows ONLY drafts.create and
//                       blocks every send path)
//   calendar.readonly - list upcoming events
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface TokenSet {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  scopes: string[]
}

export class GoogleOAuth {
  private cfg: OAuthConfig
  private fetchImpl: typeof fetch
  private now: () => number
  constructor(cfg: OAuthConfig, fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now) {
    this.cfg = cfg; this.fetchImpl = fetchImpl; this.now = now
  }

  authUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
    return `${AUTH_URL}?${q}`
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const r = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }).toString(),
    })
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok || typeof j.access_token !== 'string') throw new Error(`token endpoint HTTP ${r.status} ${String(j.error ?? '')}`.trim())
    return {
      accessToken: j.access_token,
      expiresAt: this.now() + Number(j.expires_in ?? 3600) * 1000,
      refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : undefined,
      scopes: typeof j.scope === 'string' ? j.scope.split(' ').filter(Boolean) : [],
    }
  }

  exchange(code: string): Promise<TokenSet> {
    return this.token({ code, redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code' })
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' })
  }
}
