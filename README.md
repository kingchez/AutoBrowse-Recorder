# AutoBrowse Recorder

Headless browser automation + video recording API. Runs a stealth-patched
Playwright Chromium instance on the server, executes a list of actions
(navigate, click, type, scroll, search...), records the whole thing as a
browser-native video, and returns an MP4 — job-based, same pattern as the
render server and WhisperX server in this pipeline.

## How it works

1. `POST /record` with an action list starts a job and returns a job `id`
   immediately (recording is wall-clock bound, so this is async).
2. Playwright launches headless Chromium with the stealth plugin
   (`puppeteer-extra-plugin-stealth`, applied via `playwright-extra`) and
   records the browser context natively (`recordVideo`) — no Xvfb/FFmpeg
   screen-capture needed for this.
3. Once actions finish, the context closes (finalizing the `.webm`), then
   FFmpeg converts it to `.mp4`.
4. Poll `GET /recordings/:id` for status, then `GET /recordings/:id/output`
   to stream the MP4. **The file is deleted after successful delivery**
   (consume-on-delivery), and undelivered jobs are pruned after
   `PRUNE_AFTER_HOURS` (default 48).

## API

### `POST /record`

```json
{
  "actions": [
    { "type": "goto", "url": "https://google.com" },
    { "type": "search", "text": "best ai video generators" },
    { "type": "wait", "ms": 2000 },
    { "type": "scroll", "pixels": 4000, "durationMs": 20000 }
  ],
  "options": { "width": 1920, "height": 1080 }
}
```

Returns `202 { id, status }`.

**Supported action types:** `goto`, `wait`, `waitForSelector`, `click`,
`type`, `search`, `scroll`, `pressKey`. See `src/recorder.js` for exact
parameters of each.

### `GET /recordings/:id`

Returns `{ id, status, log, error? }`. `status` is one of `processing`,
`completed`, `failed`.

### `GET /recordings/:id/output`

Streams the MP4 if `status === "completed"`. 409 if not ready, 410 if
already delivered/pruned.

### `GET /health`

Basic liveness check.

## Deployment (Dokploy)

Same pattern as `kingchez/remotion-render-server`: Dokploy builds the
`Dockerfile` in this repo (based on the official
`mcr.microsoft.com/playwright` image, which ships Chromium + all system
deps preinstalled) and deploys it as a service, e.g.
`autobrowse.viralnotely.com`.

The Playwright image is heavier than a typical Node image (Chromium +
fonts + codecs baked in) — expect a longer first build and more disk usage
than the other services in this pipeline.

## Known limitations (read before wiring into n8n)

- **Wall-clock bound.** A 20-second scroll action takes 20 real seconds.
  Doesn't parallelize well on a no-GPU VPS — two simultaneous recordings
  will visibly compete for CPU.
- **Bot detection.** The stealth plugin + non-headless-detectable
  fingerprint helps, but sites like Google can still flag a datacenter IP
  (Contabo) on repeated hits. This repo does **not** include proxy
  rotation — start without it, add residential proxies only if you
  confirm blocking is a real, recurring problem.
- **Site changes break selectors silently.** A `click`/`waitForSelector`
  step can fail if the target site's DOM changes. Consider a sanity check
  (screenshot review, or a cheap vision-model call) before feeding output
  into Remotion.
- **Login/session state.** This service does not persist logins between
  jobs. Sites requiring auth (e.g. n8n itself) need either a scripted
  login sequence in the action list, or a persisted `storageState` file
  wired in separately (not yet implemented here).
- **ToS.** Automated recording/navigation of third-party sites (Google,
  YouTube, etc.) is a gray area under most sites' Terms of Service. Low
  enforcement risk at small scale, but it's not "sanctioned" usage.
- **Shared VPS resource lock.** This service is not yet wired into the
  `vps_in_use` lock used by Chatterbox/WhisperX/render. Decide whether it
  needs its own concurrency lane or should join that same queue before
  running it in production alongside those jobs.
