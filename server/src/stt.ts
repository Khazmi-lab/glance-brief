// Speech-to-text route: POST /stt/v1/transcribe (Bearer device token, handled in server.ts).
// Body: { audio: base64 16 kHz s16le mono PCM, sampleRate: 16000, encoding?: 's16le' }.
// The backend wraps the PCM in a WAV header and forwards it to an OpenAI-compatible
// /audio/transcriptions endpoint (Whisper-style) with the server-side key and an
// allow-listed model. Only { text } is returned. Audio and text are never logged or stored.
export interface SttConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const STT_SAMPLE_RATE = 16000
export const STT_MAX_SECONDS = 15
export const STT_MAX_PCM = STT_MAX_SECONDS * STT_SAMPLE_RATE * 2
export const STT_MIN_PCM = Math.round(0.3 * STT_SAMPLE_RATE * 2)
/** JSON body cap for this route (base64 of the max PCM + envelope). */
export const STT_MAX_BODY = Math.ceil(STT_MAX_PCM / 3) * 4 + 1024
export const STT_MAX_TEXT = 1000

export class SttError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Validate the request and return the raw PCM. */
export function parseSttBody(body: unknown): Buffer {
  const b = body as { audio?: unknown; sampleRate?: unknown; encoding?: unknown }
  const keys = Object.keys((body as object) ?? {})
  if (!keys.every(k => k === 'audio' || k === 'sampleRate' || k === 'encoding')) throw new SttError(400, 'unexpected field')
  if (b?.sampleRate !== STT_SAMPLE_RATE) throw new SttError(400, 'sampleRate must be 16000')
  if (b.encoding !== undefined && b.encoding !== 's16le') throw new SttError(400, 'encoding must be s16le')
  if (typeof b.audio !== 'string' || !B64.test(b.audio) || b.audio.length % 4 !== 0) throw new SttError(400, 'audio must be base64')
  const pcm = Buffer.from(b.audio, 'base64')
  if (pcm.length % 2 !== 0) throw new SttError(400, 'audio must be whole 16-bit samples')
  if (pcm.length < STT_MIN_PCM) throw new SttError(400, 'audio too short')
  if (pcm.length > STT_MAX_PCM) throw new SttError(413, `audio longer than ${STT_MAX_SECONDS} s`)
  return pcm
}

/** 44-byte RIFF/WAVE header + PCM (mono, 16-bit). */
export function pcmToWav(pcm: Buffer, sampleRate = STT_SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export class SttProxy {
  private cfg: SttConfig | undefined
  private fetchImpl: typeof fetch
  constructor(cfg: SttConfig | undefined, fetchImpl: typeof fetch = (...a) => fetch(...a)) { this.cfg = cfg; this.fetchImpl = fetchImpl }

  get configured() { return !!this.cfg }

  async transcribe(body: unknown): Promise<{ status: number; body: { text?: string; error?: string }; seconds: number }> {
    if (!this.cfg) throw new SttError(503, 'no speech-to-text configured on the backend')
    const pcm = parseSttBody(body)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', this.cfg.model)
    form.append('response_format', 'json')
    const r = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${this.cfg.apiKey}` }, body: form,
    })
    const seconds = pcm.length / (STT_SAMPLE_RATE * 2)
    if (!r.ok) return { status: 502, body: { error: `STT HTTP ${r.status}` }, seconds }
    const j = (await r.json().catch(() => ({}))) as { text?: unknown }
    const text = typeof j.text === 'string' ? j.text.replace(/\s+/g, ' ').trim().slice(0, STT_MAX_TEXT) : ''
    return { status: 200, body: { text }, seconds }
  }
}
