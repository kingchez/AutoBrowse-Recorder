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
   to stream the MP4 — **or** pass a `callbackUrl` (see below) to get
   pushed a webhook instead of polling.  **The file is deleted after
   successful delivery** (consume-on-delivery), and undelivered jobs are
   pruned after `PRUNE_AFTER_HOURS` (default 48).

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
  "options": {
    "orientation": "vertical",
    "deviceScaleFactor": 2
  },
  "session": "optional-saved-session-name",
  "callbackUrl": "optional-webhook-url"
}
```

Returns `202 { jobId, status }`.

**Webhook delivery (`callbackUrl`):** if provided, posts JSON to that URL
instead of requiring polling: `{ source: "autobrowse", job_id, status,
output_url?, error? }`. 4 delivery attempts with 2s/5s/15s backoff. On
success (`status: "done"`), one call, with `output_url`. On a mid-job
action failure, **two** calls: the first fires the instant the action
fails — before the partial video has even finished encoding — with
`status: "error"` and no `output_url` yet, so the failure is reported as
fast as possible rather than waiting on ffmpeg. A second call follows once
the partial video finishes encoding, same `status: "error"`, now with
`output_url` populated so you can still fetch the partial recording if you
want it. On a hard failure with no video ever produced (e.g. Chromium
itself failed to launch), only the single immediate error call happens —
there's nothing to follow up with. `GET /recordings/:id` remains a valid
fallback at any point if a webhook delivery doesn't arrive.

**On job cleanup timing:** a successfully delivered webhook means "the
receiver was notified," not "the receiver already downloaded the file" —
those are different events. The in-memory job record (and the file on
disk) is only ever deleted once `output_url` has actually been fetched via
`GET /recordings/:id/output` (or the job ages past `PRUNE_AFTER_HOURS`
without being fetched at all). A webhook call that includes `output_url`
never triggers deletion on its own, regardless of how many times it's
delivered — so a slightly delayed fetch on the receiving end can never
race against an early cleanup.

**`options` fields (all optional):**
- `orientation`: `"vertical"` or `"horizontal"`. Uses a real mobile
  (iPhone-equivalent UA, touch, 1080×1920) or desktop
  (Chrome desktop UA, 1920×1080) emulation profile — not just a resized
  viewport — so the site actually renders its real mobile or desktop
  layout instead of stretching one layout into the wrong-shaped window.
- `device`: an exact Playwright device preset name (e.g. `"Pixel 5"`,
  `"iPhone 13 Pro"`) for finer control than `orientation` gives you.
- `width` / `height`: override the viewport dimensions of whichever
  profile was selected above.
- `deviceScaleFactor`: pixel density. Defaults to `2` (retina-equivalent)
  for sharper output; raise to `3` for slightly crisper text at the cost
  of a heavier render, or drop to `1` if you want faster/lighter jobs and
  don't mind softer output.

If no `orientation`/`device` is given, it defaults to a 1920×1080 desktop
profile at 2x density.

**On sharpness:** output uses `crf 16` / `preset slow` H.264 encoding —
prioritizes visual quality over encode speed — combined with
`deviceScaleFactor: 2` by default so Chromium renders at retina density
before downsampling to the final video size. This is noticeably slower to
encode than a faster preset; expect real encode time on top of the
recording's own wall-clock duration.

**On selectors:** `selector` fields throughout accept any Playwright
selector engine — plain CSS, `text=...`, `role=...`, `xpath=...`, etc. —
not just CSS. (Earlier versions of `highlight`, `zoomIn`/`zoomOut`, and
the cursor-glide-to-target behavior on `click`/`type`/`search` broke on
anything but plain CSS, since they resolved elements via
`document.querySelector` under the hood. Fixed by resolving through
Playwright's own element handle + `boundingBox()` instead, which
understands every selector engine correctly.)

**On selector ambiguity (matches multiple elements):** if a selector
matches several elements — very common on real sites with duplicated
mobile-nav markup, accessibility skip-links, off-canvas menu clones,
etc. — `click`, `type`, `search`, `highlight`, and `zoomIn` all resolve to
the first match that passes Playwright's own actionability checks
(visible, stable, enabled, not obscured or clipped by a parent), tried
against each match in turn with a fast per-candidate probe, rather than
just committing to the first DOM match. An earlier version of this tried
to approximate "is this really on-screen" with its own bounding-box-vs-
viewport math; that wasn't reliable enough (it doesn't understand things
like an off-canvas panel sitting inside an `overflow: hidden` ancestor),
so it was replaced with Playwright's real actionability engine directly.
If every match fails that check, the action fails immediately with a
clear message naming the selector, rather than a generic 15-second
timeout or (worse) silently succeeding on the wrong invisible element.

**On the cursor:** Playwright's clicks are coordinate/DOM-based — there's
no real OS mouse pointer to record. `click`, `type`, and `search` actions
now animate a fake on-screen cursor (a small pointer icon) gliding to the
target element before the action fires, so the recording visibly shows
something clicking rather than fields/buttons silently activating. The
cursor script is re-injected defensively right before each use (not just
relied on via `addInitScript`), so it stays working even if a page does an
internal redirect or otherwise replaces the document in a way that skips
the normal re-injection.

**On zoom and sticky/fixed headers (known limitation):** `zoomIn` uses a
CSS `transform: scale()` centered on the target element. CSS transforms
create a new containing block for any `position: fixed` descendant (e.g.
a sticky nav), so such elements can visibly shift or misplace during a
zoom. This is a deliberate trade-off, not an oversight: the alternative
(`zoom` instead of `transform`) doesn't have this side effect, but also
doesn't support `transform-origin` at all — it can only ever scale from
the page's top-left corner, which would break centered zooming on every
single use rather than just on pages with sticky headers. Accurate
centering was kept over avoiding this occasional glitch.

**On the blank/white start:** the first `goto` action waits for the page's
full `load` event (not just DOM-ready) before continuing, and the exact
time that took is measured and trimmed off the front of the final video —
so the output starts once the page has actually rendered, not at the
moment the browser tab was still blank.

This trim also extends to cover any `wait` actions placed immediately
after that first `goto` (a common pattern for giving a site extra time to
settle/hydrate) — the whole `goto` + leading `wait`(s) block is treated as
"page settling", not part of the intended footage, and is trimmed
together. The trim stops as soon as it hits the first action that isn't a
`goto` or leading `wait` (a `scroll`, `click`, etc.). If you actually want
an initial wait to show up in the recording (e.g. showing a loading
skeleton on purpose), set `"options": { "trimLeadingWaits": false }` to
disable this and only trim the bare `goto` time.

Note this only trims *measured dead time up to that point* — it can't
detect content that's still visually settling after the `load` event fires
(common on JS-heavy sites doing client-side rendering after the initial
load). If you're still seeing content pop in after the trim, the fix is a
longer explicit `wait`, or better, a `waitForSelector` on an element that
only appears once the page is genuinely done rendering.

**On request validation:** `POST /record` checks every action has a known
`type` and that type's required fields *before* launching a browser. A
malformed request fails instantly with `{ error: "Invalid actions",
details: [...] }` naming exactly which action and field is wrong, instead
of wasting a full browser-launch-and-navigate cycle before failing with an
opaque Playwright-internal error.

**Supported action types:** `goto`, `wait`, `waitForSelector`, `click`,
`type`, `search`, `scroll`, `pressKey`, `highlight`, `screenshot`,
`zoomIn`, `zoomOut`. See `src/recorder.js` for exact parameters of each.

- `highlight` draws a colored box around an element for a moment before
  continuing — useful so the recording visibly shows what's about to be
  clicked, rather than a click just silently happening.
- `screenshot` saves a still PNG alongside the video. Screenshots are
  listed in the `GET /recordings/:id` response under `screenshots` (an
  array of fetch URLs) once the job reaches a status with output.
- **Zoom:** `zoomIn` (`{ selector, scale?, durationMs? }`) and `zoomOut`
  (`{ durationMs? }`) push the camera in/out on any element — a CSS scale
  transform centered on that element, like a slow zoom on a chart or a
  headline. `scale` defaults to `1.5`, `durationMs` to `600`.
  For the common case — zoom in specifically to click or type into
  something — `click`, `type`, and `search` accept an optional `zoom`
  field directly: `{ "type": "click", "selector": "...", "zoom": 1.6 }`
  zooms in, performs the click, holds briefly (`zoomHoldMs`, default
  `400`ms), then zooms back out automatically. Pass `"zoomOut": false` if
  you want to stay zoomed in going into the next action instead.

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
