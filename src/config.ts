// Runtime config from the launch URL. No secrets here: the backend holds OAuth
// tokens and LLM keys; the glasses app only carries a short-lived pairing token.
//   ?backend=https://api.example.com&pair=<token>&model=<llm-model>&tz=Europe/Rome
// Without `backend`, the app runs in DEMO mode on labelled fixture data.
export interface Config {
  backend?: string
  pairingToken?: string
  model?: string
  timeZone: string
  demo: boolean
}

export function readConfig(search: string, defaultTz: string): Config {
  const p = new URLSearchParams(search)
  const backend = p.get('backend')?.replace(/\/+$/, '') || undefined
  const valid = backend ? /^https:\/\//.test(backend) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(backend) : false
  return {
    backend: valid ? backend : undefined,
    pairingToken: p.get('pair') || undefined,
    model: p.get('model') || undefined,
    timeZone: p.get('tz') || defaultTz || 'UTC',
    demo: !valid,
  }
}
