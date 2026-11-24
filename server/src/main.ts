// Entry point: `node server/src/main.ts` (Node >= 22.6 strips the types).
// Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL (e.g. https://glance.example.com)
// Optional env: PORT (8787), HOST (127.0.0.1), GLANCE_STORE_FILE + GLANCE_STORE_KEY (32 bytes base64),
//   LLM_BASE_URL (OpenAI-compatible, e.g. https://openrouter.ai/api/v1), LLM_API_KEY, LLM_MODELS (comma list),
//   CORS_ORIGINS (comma list, default *),
//   STT_BASE_URL (OpenAI-compatible /audio/transcriptions host, e.g. https://api.openai.com/v1), STT_API_KEY, STT_MODEL
import { GoogleOAuth } from './google.ts'
import { PairingService } from './pairing.ts'
import { Proxy } from './proxy.ts'
import { startServer } from './server.ts'
import { SttProxy } from './stt.ts'
import { EncryptedFileStore, MemoryStore, parseKey, type TokenStore } from './store.ts'

const env = process.env
function need(k: string): string {
  const v = env[k]
  if (!v) { console.error(`missing env ${k}`); process.exit(2) }
  return v
}
const publicUrl = need('PUBLIC_URL').replace(/\/+$/, '')
const store: TokenStore = env.GLANCE_STORE_FILE ? new EncryptedFileStore(env.GLANCE_STORE_FILE, parseKey(env.GLANCE_STORE_KEY)) : new MemoryStore()
const oauth = new GoogleOAuth({ clientId: need('GOOGLE_CLIENT_ID'), clientSecret: need('GOOGLE_CLIENT_SECRET'), redirectUri: `${publicUrl}/oauth/callback` })
const llm = env.LLM_BASE_URL && env.LLM_API_KEY
  ? { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, models: (env.LLM_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean) }
  : undefined
const stt = new SttProxy(env.STT_BASE_URL && env.STT_API_KEY && env.STT_MODEL
  ? { baseUrl: env.STT_BASE_URL, apiKey: env.STT_API_KEY, model: env.STT_MODEL }
  : undefined)
const port = Number(env.PORT ?? 8787)
await startServer({
  store, oauth, pairing: new PairingService(store), proxy: new Proxy(store, oauth, llm), stt,
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(',').map(s => s.trim()),
  log: l => console.log(new Date().toISOString(), l),
}, port, env.HOST ?? '127.0.0.1')
console.log(`glance-brief backend on ${env.HOST ?? '127.0.0.1'}:${port} (store: ${env.GLANCE_STORE_FILE ? 'encrypted file' : 'memory'}, llm: ${llm ? 'on' : 'off'}, stt: ${stt.configured ? 'on' : 'off'})`)
