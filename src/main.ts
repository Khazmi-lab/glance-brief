import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { GlanceApp } from './app'
import { readConfig } from './config'
import { mapEvent } from './core/events'
import { DemoCalendar, DemoMail, DemoReplySink } from './adapters/demo'
import { FetchHttpClient } from './adapters/http'
import { GoogleCalendarSource } from './adapters/google-calendar'
import { GmailDraftSink, GmailSource } from './adapters/gmail'
import { FallbackSummarizer, HeuristicSummarizer, LlmSummarizer } from './adapters/llm'

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
if (cfg.demo) {
  const base = new Date()
  app = new GlanceApp({
    calendar: new DemoCalendar(base), mail: new DemoMail(base), summarizer: heuristic, sink: new DemoReplySink(),
    display: display(), now: () => new Date(), timeZone: cfg.timeZone, demo: true,
  })
} else {
  const http = new FetchHttpClient(cfg.backend!, cfg.pairingToken)
  app = new GlanceApp({
    calendar: new GoogleCalendarSource(http), mail: new GmailSource(http),
    summarizer: cfg.model ? new FallbackSummarizer(new LlmSummarizer(http, cfg.model), heuristic) : heuristic,
    sink: new GmailDraftSink(http), display: display(), now: () => new Date(), timeZone: cfg.timeZone, demo: false,
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
  const m = mapEvent(event as Parameters<typeof mapEvent>[0])
  if (!m) return
  if (m.type === 'lifecycle_exit') { unsubscribe(); return }
  void app.dispatch(m)
})

await app.load()
