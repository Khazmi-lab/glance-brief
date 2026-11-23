import { readFileSync } from 'node:fs'
import type { HttpClient } from '../src/adapters/http'
import { LINE_CHARS, LINE_PX, MAX_LINES, estimatePx } from '../src/core/text'
import { expect } from 'vitest'

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

export class FakeHttp implements HttpClient {
  gets: string[] = []
  posts: { path: string; body: any }[] = []
  constructor(private routes: Record<string, unknown>, private postReply: (path: string, body: any) => unknown = () => ({})) {}
  async getJson(path: string) {
    this.gets.push(path)
    const key = Object.keys(this.routes).find(k => path.startsWith(k))
    if (!key) throw new Error(`no route ${path}`)
    return this.routes[key]
  }
  async postJson(path: string, body: unknown) {
    this.posts.push({ path, body })
    return this.postReply(path, body)
  }
}

export function expectFits(text: string) {
  const lines = text.split('\n')
  expect(lines.length).toBeLessThanOrEqual(MAX_LINES)
  for (const l of lines) expect(l.length, `line too long: "${l}"`).toBeLessThanOrEqual(LINE_CHARS)
  for (const l of lines) expect(estimatePx(l), `line too wide: "${l}"`).toBeLessThanOrEqual(LINE_PX)
}
