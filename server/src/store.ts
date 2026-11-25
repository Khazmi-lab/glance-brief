// Token storage abstraction. Holds the user's Google refresh/access tokens and the
// hashes of paired device tokens. Two implementations:
//  - MemoryStore: tests and local demos.
//  - EncryptedFileStore: single JSON file, AES-256-GCM encrypted with a 32-byte key
//    from the environment (GLANCE_STORE_KEY). Fine for a single-instance backend;
//    swap for a database/KMS-backed store in production.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface Account {
  id: string
  refreshToken: string
  accessToken?: string
  /** epoch ms */
  accessExpiresAt?: number
  /** Scopes Google actually granted (the user can untick some on the consent screen). */
  scopes: string[]
  createdAt: number
  /** Ledger of drafts THIS backend created (drafts.create). Only these may be listed or discarded. */
  appDrafts?: { id: string; createdAt: number }[]
}

export interface Device {
  tokenHash: string
  accountId: string
  createdAt: number
}

export interface TokenStore {
  getAccount(id: string): Promise<Account | undefined>
  putAccount(a: Account): Promise<void>
  deleteAccount(id: string): Promise<void>
  getDevice(tokenHash: string): Promise<Device | undefined>
  putDevice(d: Device): Promise<void>
  deleteDevice(tokenHash: string): Promise<void>
  /** Devices for an account (used to remove the account when the last device unpairs). */
  devicesFor(accountId: string): Promise<Device[]>
}

interface Snapshot { accounts: Record<string, Account>; devices: Record<string, Device> }

export class MemoryStore implements TokenStore {
  protected data: Snapshot = { accounts: {}, devices: {} }
  protected async changed(): Promise<void> {}
  async getAccount(id: string) { return this.data.accounts[id] ? { ...this.data.accounts[id] } : undefined }
  async putAccount(a: Account) { this.data.accounts[a.id] = { ...a }; await this.changed() }
  async deleteAccount(id: string) { delete this.data.accounts[id]; await this.changed() }
  async getDevice(h: string) { return this.data.devices[h] ? { ...this.data.devices[h] } : undefined }
  async putDevice(d: Device) { this.data.devices[d.tokenHash] = { ...d }; await this.changed() }
  async deleteDevice(h: string) { delete this.data.devices[h]; await this.changed() }
  async devicesFor(accountId: string) { return Object.values(this.data.devices).filter(d => d.accountId === accountId) }
}

export function parseKey(b64: string | undefined): Buffer {
  const key = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0)
  if (key.length !== 32) throw new Error('GLANCE_STORE_KEY must be 32 bytes, base64-encoded')
  return key
}

export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') })
}

export function decrypt(key: Buffer, blob: string): string {
  const { v, iv, tag, data } = JSON.parse(blob)
  if (v !== 1) throw new Error('unknown store format')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
}

export class EncryptedFileStore extends MemoryStore {
  private path: string
  private key: Buffer
  constructor(path: string, key: Buffer) {
    super()
    this.path = path; this.key = key
    if (existsSync(path)) this.data = JSON.parse(decrypt(key, readFileSync(path, 'utf8')))
  }
  protected async changed() {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, encrypt(this.key, JSON.stringify(this.data)), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
