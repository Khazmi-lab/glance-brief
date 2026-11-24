// Speech-to-text adapters.
// - BackendStt: POST /stt/v1/transcribe on the Glance Brief backend, which wraps the
//   PCM in a WAV and forwards it to an OpenAI-compatible /audio/transcriptions
//   endpoint with the server-side key (allow-listed model, size-capped). Returns text only.
// - DemoStt: DEMO / TEST DATA. Returns a fixed, labelled phrase so the simulator walk-through
//   works without a speech key; it ignores the audio content.
import type { SpeechToText } from '../core/types'
import { SAMPLE_RATE, bytesToBase64 } from '../core/voice'
import type { HttpClient } from './http'

export class BackendStt implements SpeechToText {
  constructor(private http: HttpClient, private path = '/stt/v1/transcribe') {}
  async transcribe(pcm: Uint8Array): Promise<string> {
    const r = (await this.http.postJson(this.path, { audio: bytesToBase64(pcm), sampleRate: SAMPLE_RATE, encoding: 's16le' })) as { text?: unknown }
    return typeof r?.text === 'string' ? r.text : ''
  }
}

export const DEMO_TRANSCRIPT = 'demo dictation: slide four looks good, I will check the consent text before the review'

export class DemoStt implements SpeechToText {
  async transcribe(): Promise<string> { return DEMO_TRANSCRIPT }
}
