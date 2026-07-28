# AutoBrowse Recorder

Headless browser automation + video recording API. Runs a stealth-patched
Playwright Chromium instance on the server, executes a list of actions
(navigate, click, type, scroll, search...), records the whole thing as a
browser-native video, and returns an MP4. Job-based: you submit actions,
poll for status, then fetch the finished file.

## How it works

1. `POST /record` with an action list starts a job and returns a job `id`
   immediately (recording is wall-clock bound, so this is async).
2. Playwright launches headless Chromium with a stealth plugin
   (`puppeteer-extra-plugin-stealth`, applied via `playwright-extra`) and
   records the browser context natively (`recordVideo`) — no separate
   screen-capture tooling needed for the basic case.
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
    { "type": "goto", "url": "https://example.com" },
    { "type": "search", "text": "some query" },
    { "type": "wait", "ms": 2000 },
    { "type": "scroll", "pixels": 4000, "durationMs": 20000 }
  ],
  "options": { "width": 1920, "height": 1080 },
  "session": "optional-saved-session-name"
}
```

Returns `202 { id, status }`.

**Supported action types:** `goto`, `wait`, `waitForSelector`, `click`,
`type`, `search`, `scroll`, `pressKey`, `highlight`, `screenshot`. See
`src/recorder.js` for exact parameters of each.

- `highlight` draws a colored box around an element for a moment before
  continuing — useful so the recording visibly shows what's about to be
  clicked, rather than a click just silently happening.
- `screenshot` saves a still PNG alongside the video. Screenshots are
  listed in the `GET /recordings/:id` response under `screenshots` (an
  array of fetch URLs) once the job reaches a status with output.

### `GET /recordings/:id`

Returns `{ jobId, status, log, error?, output_url?, screenshots? }`.
`status` is one of `pending`, `processing`, `done`, `error`.
`output_url` appears as soon as there's a video to fetch — **including on
`error`** if an action failed partway through (see "selector breaks" below,
this gives you the partial recording instead of nothing).

### `GET /recordings/:id/output`

Serves the MP4 if an `output_url` was present. 409 if nothing's ready yet,
410 if already delivered/pruned. **Deleted after successful delivery**
(consume-on-delivery, same as the render server this mirrors) — fetch it
once and it's gone, unless screenshots for that job are still pending
delivery, in which case the job directory (and its screenshots) sticks
around until those are also fetched or the job is pruned.

### `GET /recordings/:id/screenshots/:filename`

Serves a screenshot PNG taken mid-job via a `screenshot` action.

### Sessions (logging in once, reusing it later)

Some targets require being logged in. Rather than sending credentials with
every recording request, you create a named session once, then reference
it by name:

- **`POST /sessions`** — `{ "name": "my-session", "actions": [...login steps...] }`.
  Runs the given actions once (e.g. `goto` the login page, `type` username,
  `type` password, `click` submit), then saves the resulting cookies /
  localStorage to disk under that name. **The credentials in `actions` are
  used only in-memory for this one request** — they are never written to
  disk, logged, or echoed back in the response. Only the resulting session
  token is persisted.
- **`GET /sessions`** — lists saved session *names* only, never contents.
- **`DELETE /sessions/:name`** — revokes a saved session (e.g. once it
  expires or you log out elsewhere).
- Pass `"session": "my-session"` in a `POST /record` body to have that
  recording run already logged in.

Session files live under `SESSIONS_DIR` (`data/sessions/` by default),
which is git-ignored — they never get committed.

### `GET /health`

Basic liveness check.

## Deployment

Build the included `Dockerfile` (based on the official
`mcr.microsoft.com/playwright` image, which ships Chromium + all required
system dependencies preinstalled) and run it as a container, mapping the
port you want to `PORT` (default `3000`). It's a stateless-ish service
aside from `data/jobs` and `data/sessions`, which should be a persistent
volume if you want sessions to survive a redeploy.

The Playwright base image is heavier than a typical Node image (Chromium +
fonts + codecs baked in) — expect a longer first build and more disk usage
than a plain Node service.

## Known limitations (read before relying on this)

- **Wall-clock bound.** A 20-second scroll action takes 20 real seconds.
  Doesn't parallelize well on a constrained host — two simultaneous
  recordings will visibly compete for CPU.
- **Bot detection.** The stealth plugin helps avoid the most obvious
  headless-browser tells, but sites like Google can still flag a
  datacenter IP on repeated hits. This repo does **not** include proxy
  rotation — start without it, add residential proxies only if you
  confirm blocking is a real, recurring problem.
- **Site changes break selectors — there's no self-healing.** If a
  `click`/`waitForSelector` step no longer matches (site redesign, A/B
  test, etc.), the job stops at that action. It does **not** try to
  relearn or guess a new selector, and it does **not** require you to
  describe element positions blindly either: the job still finalizes and
  returns the video recorded up to the failure point (status `error`,
  `output_url` still present) plus which action index failed and why, in
  `GET /recordings/:id`. You (or an agent) look at that partial video/log,
  see exactly what changed, and update the action list — same as fixing
  any other code after a bug report, just with a visual instead of a
  stack trace.
- **Session expiry.** Saved sessions aren't refreshed automatically — if
  a site logs the session out, re-run `POST /sessions` to refresh it.
- **ToS.** Automated recording/navigation of third-party sites is a gray
  area under most sites' Terms of Service. Low enforcement risk at small
  scale, but it's not "sanctioned" usage.
- **No built-in concurrency lock.** If this runs alongside other
  resource-heavy services on the same host, consider adding your own
  queue/lock so they don't compete for CPU/RAM simultaneously.
