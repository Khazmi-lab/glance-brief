# Demo video script (<= 3 min; target ~2:30) — draft, 24 Nov 2026

Recorded in the Even Hub simulator unless a G2 is available. Everything shown in DEMO mode is labelled
"DEMO" on screen (invented people, example.com). A real-account segment is only included if the owner's
own Google account, OAuth client and keys are set up (see HOSTING.md); otherwise say so on camera.

| Time | Screen | Voice-over (suggested) |
|---|---|---|
| 0:00-0:15 | title card, then glasses: NEXT MEETING · in 12 min | "Glance Brief: your next meeting and your inbox at a glance, on Even G2." |
| 0:15-0:35 | swipe: Notes 1/n, attendees | "One-line AI brief and the notes you need, six lines max." |
| 0:35-0:55 | tap -> Inbox 1/3 with 12-word summary; swipe through | "Unread mail, summarised in one line each." |
| 0:55-1:20 | tap -> AI draft -> "Tap: SAVE as Gmail draft" -> DONE | "Tap to get a draft, tap again to save it as a Gmail draft. It never sends." |
| 1:20-1:50 | long press -> LISTENING -> release -> REPLY TO ... -> tap -> DONE | "Or hold and speak: speech-to-text runs on my backend, the reply is tidied, and again it is only a draft after my tap." (In DEMO mode the transcript is a fixed labelled demo phrase; say so.) |
| 1:50-2:10 | phone/laptop: pairing page with code; glasses pairing screen | "Google sign-in can't run in the glasses WebView, so the glasses show a code; I approve on my phone." |
| 2:10-2:25 | README / proxy table | "Keys stay on the backend; the proxy only allows read, draft, and transcription routes. Send is blocked and tested." |
| 2:25-2:30 | end card: repo URL, track 04 | "Built during Heads Up, track 04 AI Assistants & Work." |

Capture commands (local):
```bash
npm run build
./sim_demo.sh /tmp/v1 "" down down down click click click double_click
SIM_ARGS="--aid alsa:pulse" ./sim_demo.sh /tmp/v2 "" click long_press sleep2.5 long_press_release sleep1 click double_click
```
(The second run needs an audio input; on a desktop the default microphone works without SIM_ARGS.)
