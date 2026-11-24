// Speech-to-text route: validation, WAV wrapping, allow-listed upstream call, no logging of content.
import { afterEach, describe, expect, it } from 'vitest'
import { STT_MAX_PCM, STT_MIN_PCM, parseSttBody, pcmToWav } from '../src/stt.ts'
import { boot, pairDevice } from './harness.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })
const pcm = (n: number) => Buffer.alloc(n, 3)
const body = (b: Buffer, extra: Record<string, unknown> = {}) => ({ audio: b.toString('base64'), sampleRate: 16000, encoding: 's16le', ...extra })
const post = (base: string, b: unknown, token?: string) =>
  fetch(`${base}/stt/v1/transcribe`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) })

describe('parseSttBody / pcmToWav', () => {
  it('accepts 16 kHz s16le base64 within 0.3-15 s', () => {
    expect(parseSttBody(body(pcm(32000))).length).toBe(32000)
    expect(parseSttBody({ audio: pcm(STT_MAX_PCM).toString('base64'), sampleRate: 16000 }).length).toBe(STT_MAX_PCM)
  })
  it('rejects other rates/encodings, extra fields, bad base64, odd bytes, too short, too long', () => {
    expect(() => parseSttBody(body(pcm(32000), { sampleRate: 44100 }))).toThrow(/16000/)
    expect(() => parseSttBody(body(pcm(32000), { encoding: 'f32le' }))).toThrow(/s16le/)
    expect(() => parseSttBody(body(pcm(32000), { model: 'x' }))).toThrow(/unexpected/)
    expect(() => parseSttBody({ audio: 'not base64!', sampleRate: 16000 })).toThrow(/base64/)
    expect(() => parseSttBody(body(pcm(32001)))).toThrow(/16-bit/)
    expect(() => parseSttBody(body(pcm(STT_MIN_PCM - 2)))).toThrow(/too short/)
    expect(() => parseSttBody(body(pcm(STT_MAX_PCM + 2)))).toThrow(/longer than 15 s/)
  })
  it('writes a valid mono 16-bit WAV header', () => {
    const w = pcmToWav(pcm(3200))
    expect(w.length).toBe(44 + 3200)
    expect(w.toString('ascii', 0, 4)).toBe('RIFF')
    expect(w.toString('ascii', 8, 12)).toBe('WAVE')
    expect(w.readUInt16LE(20)).toBe(1) // PCM
    expect(w.readUInt16LE(22)).toBe(1) // mono
    expect(w.readUInt32LE(24)).toBe(16000)
    expect(w.readUInt16LE(34)).toBe(16)
    expect(w.readUInt32LE(40)).toBe(3200)
  })
})

describe('POST /stt/v1/transcribe over HTTP', () => {
  it('requires a paired device', async () => {
    const b = await boot(); close = b.close
    expect((await post(b.base, body(pcm(32000)))).status).toBe(401)
    expect(b.up.calls.some(c => c.url.includes('stt.test'))).toBe(false)
  })
  it('forwards a WAV with the server key and allow-listed model; returns only trimmed text; logs no content', async () => {
    const b = await boot({ sttText: '  yes,   friday works  ' }); close = b.close
    const token = await pairDevice(b.base)
    const r = await post(b.base, body(pcm(16000 * 2 * 2)), token)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ text: 'yes, friday works' })
    const call = b.up.calls.find(c => c.url.includes('stt.test'))!
    expect(call.url).toBe('https://stt.test/v1/audio/transcriptions')
    expect(call.auth).toBe('Bearer stt-key')
    expect(call.form).toMatchObject({ model: 'whisper-test', responseFormat: 'json', fileName: 'speech.wav', fileType: 'audio/wav' })
    expect(call.form!.wav!.length).toBe(44 + 64000)
    expect(Buffer.from(call.form!.wav!).toString('ascii', 0, 4)).toBe('RIFF')
    expect(b.logs.some(l => l === 'POST /stt/v1/transcribe -> 200 (2.0 s audio)')).toBe(true)
    expect(b.logs.join('\n')).not.toMatch(/friday|stt-key|AwMD/)
  })
  it('accepts a full 15 s clip (bigger body limit only on this route) and refuses longer', async () => {
    const b = await boot(); close = b.close
    const token = await pairDevice(b.base)
    expect((await post(b.base, body(pcm(STT_MAX_PCM)), token)).status).toBe(200)
    expect((await post(b.base, body(pcm(STT_MAX_PCM + 3200)), token)).status).toBe(413)
    // Other routes keep the small body cap.
    const big = await fetch(`${b.base}/llm/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body(pcm(STT_MAX_PCM))) }).catch(() => null)
    expect(big === null || big.status === 413).toBe(true)
  })
  it('400 on bad input, 502 on upstream error, 503 when STT is not configured', async () => {
    let b = await boot({ sttStatus: 500 }); close = b.close
    let token = await pairDevice(b.base)
    expect((await post(b.base, body(pcm(32000), { sampleRate: 8000 }), token)).status).toBe(400)
    const r = await post(b.base, body(pcm(32000)), token)
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'STT HTTP 500' })
    await b.close()
    b = await boot({ stt: false }); close = b.close
    token = await pairDevice(b.base)
    expect((await post(b.base, body(pcm(32000)), token)).status).toBe(503)
  })
})
