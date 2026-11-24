# Glance Brief — Even Realities G2 app (Heads Up hackathon, track 04 · AI Assistants & Work)

One glance at your next meeting and your unread inbox on the G2's 576x288 display,
with AI one-line summaries and a reply you approve with a tap. Nothing is ever sent:
the only write is a **Gmail draft**, and only after an explicit confirm tap.

## What existed before 23 Nov 2026 (build window opened 23 Nov, 12:00 GMT+4)
Built during the window (first app commit 23 Nov 2026). Before the window there was
**only tooling and a design note, no app code**:
- The official Even Hub `minimal` template (imported unmodified as the first commit of this repo),
  the Even Hub SDK `@evenrealities/even_hub_sdk`, CLI `@evenrealities/evenhub-cli` and
  simulator `@evenrealities/evenhub-simulator` (third-party, published by Even Realities).
- A written design note / build plan (product idea, screen list, judging notes).
- Local environment scripts: a toolchain check (`env_check.sh`) and a simulator smoke test
  (`sim_smoke.sh`) run against the unmodified template.
Everything in `src/`, `test/`, `server/`, `scripts/` and `sim_demo.sh` was written in the window
(app: 23 Nov; backend, pairing flow and `app.json` network whitelist: 24 Nov; voice reply: 24 Nov pm).
Open-source dependencies: TypeScript, Vite, Vitest.

## Screens (each ≤ 6 lines)
| Screen | Content | Input |
|---|---|---|
| Next meeting | title, start time + "in 12 min" + room, one-line AI brief, unread count | swipe = next page, tap = jump to inbox |
| Notes 1/n | invite notes paged 4 lines at a time + attendees | swipe |
| Inbox i/n | sender, subject, ≤12-word AI summary | tap = draft reply, swipe = next |
| Listening | "LISTENING... (max 15 s)" while you hold a long press on an email | release = transcribe, swipe = cancel (audio discarded) |
| Transcribing / Drafting | "Heard: …" while the dictation is tidied into a reply | swipe = cancel |
| Reply to … | AI-drafted (tap) or dictated (long press) one-sentence reply | **tap = save as Gmail draft**, swipe = cancel, hold = dictate again |
| Done | result (draft saved / error) | tap or swipe = continue |
Double tap exits from every screen (platform rule). Failures (e.g. `mail: HTTP 401`) are shown, not hidden.

## Voice reply (long press)
Hold a long press on an email, speak, release. The app opens the **glasses microphone only while the press
is held** (`audioControl(true, Glasses)`), collects the 16 kHz s16le PCM frames (format per the Even Hub
simulator docs; not yet checked on a real G2), and closes the mic on release, swipe, double tap, app exit,
or the 15 s cap. The PCM goes to the backend's `POST /stt/v1/transcribe`, which wraps it in a WAV and
forwards it to an OpenAI-compatible `/audio/transcriptions` endpoint with the server-side key and a fixed
model; only `{text}` comes back. The transcript is tidied into a short reply (LLM prompt: keep the meaning,
add no facts; offline fallback only capitalises/punctuates), then shown on the **same confirm screen**:
nothing is saved until the tap, and the only write is a Gmail **draft**. Audio and transcripts are not
stored or logged (tested). In DEMO mode a fixed, labelled demo phrase stands in for speech-to-text
(the real mic still opens, so the audio path itself is exercised in the simulator).

## Architecture
- `src/core/` pure logic: text fitting (`text.ts`: char budget + pixel estimate calibrated on
  the simulator), brief composition and paging (`brief.ts`), screen state machine (`state.ts`,
  writes only via a `save_reply` effect from the confirm screen), event routing (`events.ts`:
  CLICK=0 is omitted on the wire, scrolls arrive in `textEvent`, double-tap checked first).
- `src/adapters/` pluggable sources behind interfaces (`CalendarSource`, `MailSource`,
  `Summarizer`, `ReplySink`):
  - `google-calendar.ts` Calendar API v3 `events.list` (read-only scope).
  - `gmail.ts` Gmail API v1 `messages.list`/`messages.get?format=metadata` (read-only) and
    `drafts.create` (never `messages.send`).
  - `llm.ts` OpenAI-compatible `/chat/completions` summarizer (OpenAI / OpenRouter / Claude via
    gateway), offline heuristic fallback, per-call fallback wrapper.
  - `demo.ts` **DEMO / TEST DATA** (invented people, example.com). Shown with `DEMO` in every header.
- No secrets in the WebView: adapters call the Glance Brief backend (`?backend=https://…&model=…`),
  which holds the Google OAuth tokens and the LLM key. Without `backend` the app runs in DEMO mode.
- `src/adapters/pairing.ts` pairing client, pairing screen, device-token storage (localStorage);
  an HTTP 401 from the backend forgets the token so the next launch re-pairs.

## Backend (`server/`, Node ≥ 22.6, no runtime dependencies)
Google sign-in does not work inside the WebView, so the glasses pair with a code:
1. The app calls `POST /pair/start` and shows `Enter code ABCD-EF23` + the backend's `/pair` URL
   (10-minute, single-use code from an unambiguous alphabet; the app keeps a secret poll token).
2. On a phone/laptop the user opens `/pair`, types the code, and is sent to Google consent with
   scopes `gmail.readonly`, `gmail.compose`, `calendar.readonly` (OAuth `state` is bound to the code).
3. `/oauth/callback` exchanges the code, stores the refresh token, and approves the pairing.
4. The app's `POST /pair/poll` receives a device token **once**; the server stores only its SHA-256.
   `POST /pair/revoke` unpairs (and deletes the Google tokens with the last device).

Allow-list proxy (`server/src/proxy.ts`), everything else is 404:
| App call | Forwarded to | Limits |
|---|---|---|
| `GET /gmail/v1/users/me/messages` | Gmail `messages.list` | `q`, `maxResults ≤ 20`, `pageToken` only |
| `GET /gmail/v1/users/me/messages/:id` | Gmail `messages.get` | **forced `format=metadata`**, From/Subject/Date/To headers |
| `POST /gmail/v1/users/me/drafts` | Gmail `drafts.create` | body must be `{message:{raw,threadId?}}`; returns only the draft id |
| `GET /calendar/v3/calendars/:id/events` | Calendar `events.list` | timeMin/timeMax/singleEvents/orderBy/`maxResults ≤ 20` |
| `POST /llm/v1/chat/completions` | OpenAI-compatible LLM | model allow-list, ≤ 4 system/user messages, ≤ 8,000 chars, `max_tokens ≤ 200` |
| `POST /stt/v1/transcribe` | OpenAI-compatible `/audio/transcriptions` (WAV) | 16 kHz s16le base64 only, 0.3–15 s, fixed model (`STT_MODEL`), returns `{text}` ≤ 1,000 chars |
Google has no drafts-only scope: `gmail.compose` could also send, so **send is blocked in the
proxy** (no `messages/send`, `drafts/send`, modify, trash or delete route exists; tested). Drafts are
refused with 403 if the user unticked `gmail.compose` on the consent screen. Access tokens are
refreshed server-side (and once on an upstream 401). Rate limits: code entry 10/10 min per IP,
`/pair/start` 20/10 min per IP, 120 proxied calls/min per device. Logs contain no tokens, codes or
message content (tested). Token store: `MemoryStore` or `EncryptedFileStore` (AES-256-GCM, key from env).

```bash
PUBLIC_URL=https://your-backend.example GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
GLANCE_STORE_FILE=./store.json GLANCE_STORE_KEY=$(openssl rand -base64 32) \
LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=… LLM_MODELS=<model> \
STT_BASE_URL=https://api.openai.com/v1 STT_API_KEY=… STT_MODEL=whisper-1 npm run server
node scripts/set-whitelist.mjs https://your-backend.example && npm run pack   # app.json network whitelist
```
The committed `app.json` whitelists `http://localhost:8787` (local development). A hosted backend URL,
a Google Cloud OAuth client (the owner's), an LLM key and an STT key are still needed for a real-account demo.
Hosting plan: [HOSTING.md](HOSTING.md). Video script: [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
`app.json` also declares the `g2-microphone` permission (used only during a held long press).

## Display budget
Simulator 0.9.5 calibration (`?calibrate=1`): one line fits ~35 `W`/`M`, ~51 `a`, ~62 chars of
mixed prose; line pitch ~27 px (≈10 lines). We use ≤ 6 lines × ≤ 40 chars plus a pixel-width guard
(`fitPx`). The renderer collapses runs of spaces and has no `…` glyph, so we use ` · ` separators and `...`.

## Run
```bash
npm install
npm test            # vitest: app + backend unit/HTTP tests + app<->backend end-to-end (Google/LLM are fakes; fixtures are synthetic TEST DATA)
npm run build       # tsc (app + server) + vite build
npm run pack        # -> glance-brief.ehpk (local only)
./sim_demo.sh /tmp/out "" down down down click click click double_click        # demo-data walk-through
./sim_demo.sh /tmp/out "?backend=http://localhost:8787" double_click          # pairing screen (backend running)
SIM_ARGS="--aid alsa:pulse" ./sim_demo.sh /tmp/out "" click long_press sleep2.5 long_press_release sleep1 click double_click  # voice reply (needs an audio input)
```

## Status (24 Nov 2026, afternoon)
Done: core logic, adapters, demo mode, backend (pairing-code OAuth, token store, allow-list Gmail/
Calendar/LLM/STT proxy), pairing flow in the app, `app.json` network whitelist + microphone permission,
voice reply (long press), 114 tests, build, `.ehpk` pack, simulator walk-throughs (demo data; pairing
screen against the local backend; voice reply with real simulator audio frames from a virtual test tone
and the labelled demo transcript).
Not tested against real Google, a real LLM, or a real speech-to-text service (all upstreams are test
doubles so far); voice not tried on a real G2.
Demo video (≤ 3 min): real Even Hub simulator 0.9.5 captures of this build in DEMO mode plus the
pairing screen against the local backend (see the BUIDL page for the link).
Not done: hosting (plan only, see HOSTING.md), Notion "ask my notes", real-account demo (needs the
owner's own Google account/OAuth client, an LLM key and an STT key).

## Third-party code
The first commit is the official Even Hub `minimal` template, unmodified; SDK, CLI and simulator are
published by Even Realities under their own terms and are installed from npm, not vendored here.

## License
MIT © 2026 Metaz Al Khazmi — see [LICENSE](LICENSE).
