import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import { GlanceApp } from './app'
import { readConfig } from './config'
import { mapEvent } from './core/events'
import { DemoCalendar, DemoMail, DemoReplySink } from './adapters/demo'
import { FetchHttpClient } from './adapters/http'
import { PairingClient, TOKEN_KEY, browserStorage, runPairing } from './adapters/pairing'
import { GoogleCalendarSource } from './adapters/google-calendar'
import { GmailDraftSink, GmailSource } from './adapters/gmail'
import { FallbackSummarizer, HeuristicSummarizer, LlmSummarizer } from './adapters/llm'
import { BackendStt, DemoStt } from './adapters/stt'
import type { Mic } from './core/types'

const bridge = await waitForEvenAppBridge()
const cfg = readConfig(location.search, Intl.DateTimeFormat().resolvedOptions().timeZone)

const main = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 288,
  borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 1, containerName: 'main',
  content: 'GLANCE BRIEF\nLoading...', isEventCapture: 1,
})
const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }))
console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

const heuristic = new HeuristicSummarizer()
let app: GlanceApp
if (new URLSearchParams(location.search).has('calibrate')) {
  // Dev aid: measure how many characters fit per line on the 576 px display.
  const rows = ['W'.repeat(44), 'M'.repeat(44), 'm'.repeat(50), 'a'.repeat(60), 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do', '0123456789'.repeat(6), 'A  B   C (spaces)', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12']
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: rows.join('\n') }))
  console.log('[glance] screen: calibration')
  throw new Error('calibration mode')
}
let exiting = false
// Glasses microphone (16 kHz s16le PCM frames arrive as audioEvent). Opened only while
// the user holds a long press on an email; closed on release, swipe, cap or exit.
const mic: Mic = {
  open: async () => { const ok = await bridge.audioControl(true, AudioInputSource.Glasses); console.log('[glance] mic open:', ok); return ok },
  close: async () => { console.log('[glance] mic close, captured bytes:', app?.voice.bytes ?? 0); await bridge.audioControl(false) },
}
if (cfg.demo) {
  const base = new Date()
  app = new GlanceApp({
    calendar: new DemoCalendar(base), mail: new DemoMail(base), summarizer: heuristic, sink: new DemoReplySink(),
    display: display(), now: () => new Date(), timeZone: cfg.timeZone, demo: true,
    mic, stt: new DemoStt(),
  })
} else {
  // Device token: launch URL (?pair=) for development, else storage, else pair now.
  const storage = browserStorage()
  let token = cfg.pairingToken ?? storage.get(TOKEN_KEY) ?? undefined
  if (!token) {
    // Exit must work during pairing too (platform rule: double tap exits everywhere).
    const stopPairing = bridge.onEvenHubEvent(event => {
      const m = mapEvent(event as Parameters<typeof mapEvent>[0])
      if (m?.type === 'double_click') { exiting = true; void bridge.shutDownPageContainer(1) }
    })
    token = (await runPairing({
      client: new PairingClient(cfg.backend!), baseUrl: cfg.backend!, show: display().show,
      now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), cancelled: () => exiting,
    })) ?? undefined
    stopPairing()
    if (!token) throw new Error('not paired')
    storage.set(TOKEN_KEY, token)
  }
  const http = new FetchHttpClient(cfg.backend!, token, undefined, () => storage.remove(TOKEN_KEY))
  app = new GlanceApp({
    calendar: new GoogleCalendarSource(http), mail: new GmailSource(http),
    summarizer: cfg.model ? new FallbackSummarizer(new LlmSummarizer(http, cfg.model), heuristic) : heuristic,
    sink: new GmailDraftSink(http), display: display(), now: () => new Date(), timeZone: cfg.timeZone, demo: false,
    mic, stt: new BackendStt(http),
  })
}

function display() {
  return {
    show: async (text: string) => {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }))
      console.log('[glance] screen:', text.split('\n')[0])
    },
    exit: async () => { await bridge.shutDownPageContainer(1) },
  }
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent
  if (audio) { app.pushAudio(audio.audioPcm); return }
  const m = mapEvent(event as Parameters<typeof mapEvent>[0])
  if (!m) return
  if (m.type === 'lifecycle_exit') { app.voice.discard(); void mic.close().catch(() => {}); unsubscribe(); return }
  void app.dispatch(m)
})

await app.load()
