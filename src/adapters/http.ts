// Minimal JSON HTTP client interface so adapters can be tested with recorded
// fixtures and so the WebView never holds API keys: in production `baseUrl`
// points at the Glance Brief backend, which attaches the user's OAuth token /
// LLM key server-side (see README "Architecture").
export interface HttpClient {
  getJson(path: string): Promise<unknown>
  postJson(path: string, body: unknown): Promise<unknown>
}

export class FetchHttpClient implements HttpClient {
  constructor(
    private baseUrl: string,
    private pairingToken?: string,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    /** Called on HTTP 401 (device token revoked/unknown) so the app can forget it and re-pair. */
    private onUnauthorized?: () => void,
  ) {}
  private check(r: Response, what: string) {
    if (r.status === 401) this.onUnauthorized?.()
    if (!r.ok) throw new Error(`${what} -> HTTP ${r.status}`)
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' }
    if (this.pairingToken) h.authorization = `Bearer ${this.pairingToken}`
    return h
  }
  async getJson(path: string): Promise<unknown> {
    const r = await this.fetchImpl(this.baseUrl + path, { headers: this.headers() })
    this.check(r, `GET ${path.split('?')[0]}`)
    return r.json()
  }
  async postJson(path: string, body: unknown): Promise<unknown> {
    const r = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    this.check(r, `POST ${path.split('?')[0]}`)
    return r.json()
  }
}
