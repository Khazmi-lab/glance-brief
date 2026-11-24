// Voice capture buffer for the reply-by-voice flow (pure, no bridge).
// Audio format from the Even Hub simulator README (v0.9.x) and our design note:
// 16 kHz, signed 16-bit little-endian mono PCM, ~100 ms (3,200 B) per audioEvent.
// Not yet verified on real G2 hardware.
export const SAMPLE_RATE = 16000
export const BYTES_PER_SEC = SAMPLE_RATE * 2
/** Hard cap on one dictation (keeps the upload small and the reply short). */
export const MAX_SECONDS = 15
export const MAX_BYTES = MAX_SECONDS * BYTES_PER_SEC
/** Anything shorter than this is treated as an accidental press. */
export const MIN_BYTES = Math.round(0.3 * BYTES_PER_SEC)

/** Accepts the forms the host may deliver audioPcm in: Uint8Array, number[], or base64 string. */
export function toBytes(pcm: unknown): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm
  if (Array.isArray(pcm)) return Uint8Array.from(pcm.map(n => Number(n) & 0xff))
  if (typeof pcm === 'string' && pcm) {
    const bin = atob(pcm)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(0)
}

export class VoiceBuffer {
  private chunks: Uint8Array[] = []
  private size = 0
  recording = false

  start() { this.chunks = []; this.size = 0; this.recording = true }

  /** Append a frame while recording. Returns true when the cap is reached (caller should stop). */
  push(frame: Uint8Array): boolean {
    if (!this.recording || frame.length === 0) return false
    const room = MAX_BYTES - this.size
    if (room <= 0) return true
    const part = frame.length > room ? frame.subarray(0, room) : frame
    this.chunks.push(part)
    this.size += part.length
    return this.size >= MAX_BYTES
  }

  get bytes() { return this.size }
  get seconds() { return this.size / BYTES_PER_SEC }

  /** Stop and return the audio (trimmed to whole 16-bit samples). Clears the buffer. */
  stop(): Uint8Array {
    this.recording = false
    const out = new Uint8Array(this.size - (this.size % 2))
    let off = 0
    for (const c of this.chunks) {
      const n = Math.min(c.length, out.length - off)
      out.set(c.subarray(0, n), off)
      off += n
    }
    this.chunks = []; this.size = 0
    return out
  }

  /** Stop and drop everything (cancel / exit). */
  discard() { this.recording = false; this.chunks = []; this.size = 0 }
}

/** Standard base64 for a byte array (chunked so large buffers don't blow the stack). */
export function bytesToBase64(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(bin)
}
