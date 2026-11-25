// Pending-drafts tracker backed by the Glance Brief backend's ledger.
// The backend records the id of every draft it creates for this account (drafts.create) and:
//   GET  /glance/drafts           -> those drafts that still exist (sent/deleted ones drop out)
//   POST /glance/drafts/discard   -> deletes ONLY ids from that ledger (anything else: 403)
// There is still no send route anywhere. The app calls discard only after a confirm tap.
import type { DraftTracker, PendingDraft } from '../core/types'
import type { HttpClient } from './http'

export function parseDrafts(body: unknown): PendingDraft[] {
  const list = (body as { drafts?: { id?: unknown; to?: unknown; subject?: unknown; createdAt?: unknown }[] })?.drafts ?? []
  const out: PendingDraft[] = []
  for (const d of list) {
    if (typeof d.id !== 'string' || typeof d.createdAt !== 'number') continue
    const to = typeof d.to === 'string' ? d.to : ''
    const name = to.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/)?.[1]?.trim()
    out.push({ id: d.id, to: name || to.split('@')[0] || '(unknown)', subject: typeof d.subject === 'string' ? d.subject : '', createdAt: new Date(d.createdAt) })
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

export class BackendDrafts implements DraftTracker {
  constructor(private http: HttpClient) {}
  async pending(): Promise<PendingDraft[]> {
    return parseDrafts(await this.http.getJson('/glance/drafts'))
  }
  async discard(ids: string[]): Promise<number> {
    if (!ids.length) return 0
    const r = (await this.http.postJson('/glance/drafts/discard', { ids })) as { discarded?: unknown }
    return typeof r?.discarded === 'number' ? r.discarded : 0
  }
}
