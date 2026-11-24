// Random codes/tokens and hashing. Device tokens are stored only as SHA-256 hashes.
import { createHash, randomBytes, randomInt } from 'node:crypto'

/** No 0/O/1/I/L: easy to read off a small display and type on a phone. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** 8-character pairing code shown as XXXX-XXXX (~39 bits; short-lived, single use, rate limited). */
export function newPairingCode(): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

/** Normalise user input: case, spaces and dashes. */
export function normaliseCode(input: string): string {
  const s = input.toUpperCase().replace(/[\s-]+/g, '')
  if (!/^[A-Z2-9]{8}$/.test(s)) return ''
  if ([...s].some(c => !CODE_ALPHABET.includes(c))) return ''
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
