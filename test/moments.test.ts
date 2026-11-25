// v0.4 app flows (DEMO data = invented test data): drafts reminder + confirm-before-discard,
// meeting context page, back-to-back glance card. Nothing here can send email.
import { describe, expect, it } from 'vitest'
import { GlanceApp } from '../src/app'
import { DemoCalendar, DemoDrafts, DemoMail, DemoReplySink, type DemoScenario } from '../src/adapters/demo'
import { BackendDrafts, parseDrafts } from '../src/adapters/drafts'
import { HeuristicSummarizer } from '../src/adapters/llm'
import { initialState, reduce } from '../src/core/state'
import type { Page } from '../src/core/brief'
import type { DraftTracker } from '../src/core/types'
import { FakeHttp, expectFits } from './helpers'

const now = new Date('2026-11-23T13:20:00Z') // 14:20 Europe/Rome
function setup(scenario: DemoScenario, tracker: DraftTracker | null = new DemoDrafts(now)) {
  const drafts = tracker ?? undefined
  const shown: string[] = []
  const app = new GlanceApp({
    calendar: new DemoCalendar(now, scenario), mail: new DemoMail(now), summarizer: new HeuristicSummarizer(), sink: new DemoReplySink(),
    display: { show: t => { shown.push(t) }, exit: () => {} }, now: () => now, timeZone: 'Europe/Rome', demo: true, drafts,
  })
  return { app, shown, drafts, last: () => shown.at(-1)! }
}

describe('pending-drafts reminder', () => {
  it('just after a meeting: "drafts waiting" is the first screen, with the stale count', async () => {
    const t = setup('after')
    await t.app.load()
    const first = t.shown[0].split('\n')
    expect(first[0]).toBe('DRAFTS WAITING · DEMO 14:20')
    expect(first[1]).toBe('Meeting over. 3 replies not sent yet')
    expect(first[2]).toBe('In Gmail Drafts: send them there.')
    expect(first[3]).toBe('2 older than 3 days · oldest 6 d')
    t.shown.forEach(expectFits)
  })
  it('discards stale app-created drafts ONLY after the confirm tap; swipe keeps them', async () => {
    const t = setup('after')
    await t.app.load()
    await t.app.dispatch({ type: 'click' })
    expect(t.last().split('\n')[0]).toBe('DISCARD 2 OLD DRAFTS?')
    expect(t.last()).toContain('Luca (demo) · 6 d')
    expect(t.last()).toContain('Only drafts Glance Brief made.')
    expect((await t.drafts!.pending()).length).toBe(3) // nothing deleted yet
    await t.app.dispatch({ type: 'down' }) // swipe = keep
    expect((await t.drafts!.pending()).length).toBe(3)
    expect(t.last().split('\n')[0]).toMatch(/^DRAFTS WAITING/)
    await t.app.dispatch({ type: 'click' })
    await t.app.dispatch({ type: 'click' }) // confirm
    expect(t.last()).toMatch(/^DONE\nDiscarded 2 old drafts/)
    expect((await t.drafts!.pending()).map(d => d.id)).toEqual(['demo-new-1']) // the recent draft is kept
    t.shown.forEach(expectFits)
  })
  it('during the day with a meeting coming up, the drafts card waits at the end of the scroll', async () => {
    const t = setup('default')
    await t.app.load()
    expect(t.shown[0].split('\n')[0]).toBe('NEXT MEETING · DEMO 14:20')
    const kinds = t.app.state.pages.map(p => p.kind)
    expect(kinds.at(-1)).toBe('drafts')
    expect(kinds[0]).toBe('meeting')
  })
  it('saving a reply adds it to the waiting count and says where it is', async () => {
    const t = setup('default')
    await t.app.load()
    const firstEmail = t.app.state.pages.findIndex(p => p.kind === 'email')
    for (let i = 0; i < firstEmail; i++) await t.app.dispatch({ type: 'down' })
    await t.app.dispatch({ type: 'click' })
    await t.app.dispatch({ type: 'click' })
    expect(t.last()).toContain('4 waiting in')
    expect((await t.drafts!.pending()).length).toBe(4)
    const draftsPage = t.app.state.pages.find(p => p.kind === 'drafts')!
    expect(draftsPage.lines[1]).toBe('4 replies not sent yet')
  })
  it('no tracker or no drafts -> no drafts card', async () => {
    const t = setup('after', null)
    await t.app.load()
    expect(t.app.state.pages.some(p => p.kind === 'drafts')).toBe(false)
    const empty: DraftTracker = { pending: async () => [], discard: async () => 0 }
    const u = setup('after', empty)
    await u.app.load()
    expect(u.app.state.pages.some(p => p.kind === 'drafts')).toBe(false)
  })
  it('the demo ledger refuses ids it did not create', async () => {
    await expect(new DemoDrafts(now).discard(['someone-elses-draft'])).rejects.toThrow(/not a Glance Brief draft/)
  })
  it('state machine: no discard effect without the confirm screen; drafts card without stale drafts just continues', () => {
    const page: Page = { kind: 'drafts', lines: ['x'], staleIds: ['a'], confirmLines: ['DISCARD 1 OLD DRAFT?'] }
    const other: Page = { kind: 'meeting', lines: ['m'] }
    let r = reduce(initialState([page, other]), { type: 'click' })
    expect(r.effects).toEqual([])
    expect(r.state.mode).toBe('discard_confirm')
    r = reduce(r.state, { type: 'click' })
    expect(r.effects).toEqual([{ type: 'discard_drafts', ids: ['a'] }])
    const fresh = reduce(initialState([{ kind: 'drafts', lines: ['x'] }, other]), { type: 'click' })
    expect(fresh.effects).toEqual([])
    expect(fresh.state.index).toBe(1)
  })
  it('backend tracker: GET /glance/drafts, POST /glance/drafts/discard, never a send path', async () => {
    const h = new FakeHttp({ '/glance/drafts': { drafts: [{ id: 'r2', to: 'Sara Rossi <s@x.io>', subject: 'Re: a', createdAt: 2 }, { id: 'r1', to: 'b@x.io', subject: 'Re: b', createdAt: 1 }, { id: 5 }] } }, () => ({ discarded: 1 }))
    const t = new BackendDrafts(h)
    expect((await t.pending()).map(d => [d.id, d.to])).toEqual([['r1', 'b'], ['r2', 'Sara Rossi']])
    expect(await t.discard(['r1'])).toBe(1)
    expect(h.posts).toEqual([{ path: '/glance/drafts/discard', body: { ids: ['r1'] } }])
    expect(await t.discard([])).toBe(0)
    expect(h.posts).toHaveLength(1)
    expect(parseDrafts(null)).toEqual([])
  })
})

describe('meeting context: pending items from recent mail with the attendees', () => {
  it('adds a PENDING page after the meeting card, and the count on the card', async () => {
    const t = setup('default')
    await t.app.load()
    const [meeting, pending] = t.app.state.pages
    expect(meeting.lines.at(-1)).toBe('2 pending · 3 unread · swipe')
    expect(pending.kind).toBe('pending')
    expect(pending.lines.slice(1)).toEqual([
      '- Sara: check slide 4 before 15:30',
      '- Marco: bring the drop-off numbers per',
      'step',
      'Mail with them, last 14 days',
    ])
    expect(pending.lines[0]).toMatch(/^PENDING · 2 from mail .*DEMO 14:20$/)
    t.app.state.pages.forEach(p => expectFits(p.lines.join('\n')))
  })
})

describe('back-to-back mode', () => {
  it('shows a one-glance card first (who · what · one pending item), then the full brief', async () => {
    const t = setup('b2b')
    await t.app.load()
    const g = t.shown[0].split('\n')
    expect(g[0]).toMatch(/^BACK-TO-BACK .*DEMO 14:20$/)
    expect(g[1]).toBe('Next 14:24 in 4 min · Room Aurora')
    expect(g[2]).toMatch(/^Marco \(demo\), Sara \(demo\): Design/)
    expect(g.slice(3, -1).join(' ')).toBe('Pending: Sara: check slide 4 before 15:30')
    expect(g.at(-1)).toBe('Tap or swipe: full brief')
    await t.app.dispatch({ type: 'click' })
    expect(t.last().split('\n')[0]).toMatch(/^NEXT MEETING/)
    expect(t.last()).toContain('Design review')
    t.shown.forEach(expectFits)
  })
  it('back-to-back never promotes the drafts card over the glance card', async () => {
    const t = setup('b2b')
    await t.app.load()
    expect(t.app.state.pages[0].kind).toBe('glance')
    expect(t.app.state.pages.at(-1)!.kind).toBe('drafts')
  })
})
