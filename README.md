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
`type`, `search`, `scroll`, `pressKey`. See `src/recorder.js` for exact
parameters of each.

### `GET /recordings/:id`

Returns `{ id, status, log, error? }`. `status` is one of `processing`,
`completed`, `failed`.

### `GET /recordings/:id/output`

Streams the MP4 if `status === "completed"`. 409 if not ready, 410 if
already delivered/pruned.

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
- **Site changes break selectors silently.** A `click`/`waitForSelector`
  step can fail if the target site's DOM changes. Consider a sanity check
  before relying on output for anything downstream.
- **Session expiry.** Saved sessions aren't refreshed automatically — if
  a site logs the session out, re-run `POST /sessions` to refresh it.
- **ToS.** Automated recording/navigation of third-party sites is a gray
  area under most sites' Terms of Service. Low enforcement risk at small
  scale, but it's not "sanctioned" usage.
- **No built-in concurrency lock.** If this runs alongside other
  resource-heavy services on the same host, consider adding your own
  queue/lock so they don't compete for CPU/RAM simultaneously.
