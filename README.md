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
Everything in `src/`, `test/`, and `sim_demo.sh` was written in the window.
Open-source dependencies: TypeScript, Vite, Vitest.

## Screens (each ≤ 6 lines)
| Screen | Content | Input |
|---|---|---|
| Next meeting | title, start time + "in 12 min" + room, one-line AI brief, unread count | swipe = next page, tap = jump to inbox |
| Notes 1/n | invite notes paged 4 lines at a time + attendees | swipe |
| Inbox i/n | sender, subject, ≤12-word AI summary | tap = draft reply, swipe = next |
| Reply to … | AI-drafted one-sentence reply | **tap = save as Gmail draft**, swipe = cancel |
| Done | result (draft saved / error) | tap or swipe = continue |
Double tap exits from every screen (platform rule). Failures (e.g. `mail: HTTP 401`) are shown, not hidden.

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
- No secrets in the WebView: adapters call a backend (`?backend=https://…&pair=<pairing token>&model=…`)
  that holds the OAuth token and LLM key. Google sign-in does not work inside the WebView, so the
  plan is a separate login page + pairing code. **The backend is not written yet** (next step).
  Without `backend` the app runs in DEMO mode.

## Display budget
Simulator 0.9.5 calibration (`?calibrate=1`): one line fits ~35 `W`/`M`, ~51 `a`, ~62 chars of
mixed prose; line pitch ~27 px (≈10 lines). We use ≤ 6 lines × ≤ 40 chars plus a pixel-width guard
(`fitPx`). The renderer collapses runs of spaces and has no `…` glyph, so we use ` · ` separators and `...`.

## Run
```bash
npm install
npm test            # vitest unit + integration tests (fixtures in test/fixtures are synthetic TEST DATA)
npm run build       # tsc --noEmit + vite build
npm run pack        # -> glance-brief.ehpk (local only)
./sim_demo.sh /tmp/out "" down down down click click click double_click   # headless simulator walk-through
```

## Status (23 Nov 2026)
Done: core logic, adapters, demo mode, 49 tests, build, `.ehpk` pack, simulator walk-through.
Not done: backend (OAuth pairing, proxy, LLM key), voice reply (long press), Notion "ask my notes",
real-account demo (needs the owner's own Google account and an LLM key).
