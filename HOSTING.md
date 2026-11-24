# Hosting plan (draft, 24 Nov 2026) — nothing is deployed yet

Glance Brief has two parts. Both must be reachable over HTTPS for a real-account demo on G2.

| Part | What it is | Where it can run |
|---|---|---|
| Glasses app | static files from `npm run build` (`dist/`), packed into `glance-brief.ehpk` | inside the Even Realities App (the `.ehpk`); the simulator loads it from a local dev server |
| Backend | `node server/src/main.ts` (Node >= 22.6, no runtime dependencies) | any host that runs a long-lived Node 22 process with HTTPS and a writable file (token store) |

The backend is stateful (pairing codes in memory, tokens in `GLANCE_STORE_FILE`), so it needs **one
always-on instance** with a persistent disk, not a serverless function that is frozen between calls.

## Option A (recommended for the demo): small VM or container host with a persistent volume
1. Create a Node 22 service from the public repo, start command `node server/src/main.ts`, `HOST=0.0.0.0`.
2. Attach a small persistent volume and set `GLANCE_STORE_FILE=/data/store.json`,
   `GLANCE_STORE_KEY=$(openssl rand -base64 32)` (keep this key only in the host's secret settings).
3. Set `PUBLIC_URL=https://<the service URL>` (no trailing slash), `CORS_ORIGINS=*` (auth is a Bearer
   header, no cookies; tighten later if the WebView origin is known).
4. Google Cloud (owner's own project): OAuth client "Web application", authorised redirect URI
   `https://<service>/oauth/callback`, scopes `gmail.readonly`, `gmail.compose`, `calendar.readonly`.
   While the consent screen is in "Testing", add the demo Google account as a test user.
   Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. LLM (optional; heuristic fallback without it): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODELS=<model>`.
6. Speech-to-text (voice reply; without it long press shows "Voice failed: ... HTTP 503"):
   `STT_BASE_URL` (OpenAI-compatible host whose `/audio/transcriptions` accepts a WAV upload, e.g.
   `https://api.openai.com/v1`), `STT_API_KEY`, `STT_MODEL` (e.g. `whisper-1`).
7. Point the app at it: `node scripts/set-whitelist.mjs https://<service>` then `npm run pack`, and
   launch with `?backend=https://<service>&model=<model>`.
8. Check: `GET /healthz` -> `{"ok":true}`; the startup log line shows `llm: on, stt: on`.

## Option B: run the backend on the owner's own computer behind an HTTPS tunnel
Same env vars; `PUBLIC_URL` = the tunnel URL. Fine for recording the demo video, but the URL changes
on restart (then re-run `set-whitelist.mjs`, re-pack, and update the Google redirect URI).

## Not decided / needs the owner
- Which host or tunnel (may involve an account and, on some hosts, a paid plan: owner's decision).
- Google Cloud OAuth client, the Google account used in the demo, LLM key, STT key.
- Nothing in this repo contains or needs real keys; never commit them.

## Smoke checks already done locally (no external hosting)
- Real server process starts with test env values and reports `stt: on`; `/healthz` 200;
  `/stt/v1/transcribe` refuses requests without a valid device token (401).
- Full pairing, Gmail/Calendar/LLM/STT proxy behaviour is covered by the HTTP tests against fake upstreams.
