const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { devices } = require('playwright'); // for device UA/mobile presets only - launch still goes through playwright-extra above
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

// Real desktop and mobile emulation profiles pulled from Playwright's own
// device database - matches Chrome DevTools' device toolbar. Using these
// (rather than a bare width/height) is what makes a site render its actual
// mobile or desktop layout instead of just stretching a desktop layout over
// whatever viewport size was requested.
const IPHONE_UA = devices['iPhone 13'].userAgent;
const DESKTOP_UA = devices['Desktop Chrome HiDPI'].userAgent;

// Playwright's click()/type() are coordinate/DOM based - there is no real OS
// mouse pointer to record. This injects a fake cursor element into every
// page (including after navigations, via addInitScript) plus a global
// window.__abMoveCursorTo(x, y, instant) function used to visibly glide it
// to a target before an action happens, so the recording actually shows
// something clicking rather than things just silently activating.
function cursorInitScript() {
  const CURSOR_ID = '__autobrowse_cursor__';
  if (document.getElementById(CURSOR_ID)) return;

  const style = document.createElement('style');
  style.textContent = `
    #${CURSOR_ID} {
      position: fixed;
      top: 0; left: 0;
      width: 22px; height: 22px;
      margin-left: -2px; margin-top: -2px;
      pointer-events: none;
      z-index: 2147483647;
      transition: transform 400ms cubic-bezier(0.22, 0.61, 0.36, 1);
      will-change: transform;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
    }
  `;
  document.documentElement.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = CURSOR_ID;
  cursor.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 1 L2 18 L6.5 14.5 L9.5 20.5 L12 19.3 L9 13.3 L15 13 Z"
            fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>
  `;
  cursor.style.transform = 'translate(-100px, -100px)'; // start off-screen until first move
  document.documentElement.appendChild(cursor);

  window.__abMoveCursorTo = (x, y, instant) => {
    const el = document.getElementById(CURSOR_ID);
    if (!el) return;
    el.style.transition = instant ? 'none' : 'transform 400ms cubic-bezier(0.22, 0.61, 0.36, 1)';
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
}

// Zooms the whole page in on `selector` by applying a CSS scale transform
// with its origin centered on that element - like a camera push-in. This
// affects layout visually only (the transform doesn't change actual DOM
// geometry beyond what CSS transforms always do), and Playwright's own
// click()/evaluate() hit-testing correctly accounts for the transform, so
// clicking after a zoom still targets the right (now larger) element.
//
// Uses page.waitForSelector(...).boundingBox() rather than
// document.querySelector inside page.evaluate - the latter only
// understands plain CSS and breaks on Playwright's own extended selector
// engines (text=, role=, xpath=, etc.), which are otherwise valid and
// commonly used for `selector` throughout this file.
async function zoomToElement(page, selector, scale = 1.5, durationMs = 600) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  const box = await el.boundingBox();
  if (!box) return; // element matched but isn't visible/laid out - nothing to zoom to
  const viewport = page.viewportSize();
  const originX = ((box.x + box.width / 2) / viewport.width) * 100;
  const originY = ((box.y + box.height / 2) / viewport.height) * 100;
  await page.evaluate(({ originX, originY, scale, durationMs }) => {
    const html = document.documentElement;
    html.style.transition = `transform ${durationMs}ms ease-in-out`;
    html.style.transformOrigin = `${originX}% ${originY}%`;
    html.style.transform = `scale(${scale})`;
    html.style.overflow = 'hidden'; // avoid scrollbars/edge artifacts while zoomed
  }, { originX, originY, scale, durationMs });
  await page.waitForTimeout(durationMs);
}

// Reverses zoomToElement back to scale(1), same transition duration.
async function zoomReset(page, durationMs = 600) {
  await page.evaluate((durationMs) => {
    const html = document.documentElement;
    html.style.transition = `transform ${durationMs}ms ease-in-out`;
    html.style.transform = 'scale(1)';
  }, durationMs);
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => {
    document.documentElement.style.overflow = '';
  });
}

// Moves the fake cursor to the center of `selector` and waits for the glide
// animation to finish, so the click/type that follows visibly lines up with
// where the cursor just arrived.
//
// Defensively re-runs cursorInitScript() via page.evaluate right before use
// (it's idempotent - the early "already exists" check inside it makes this
// a no-op if the cursor is already there). page.addInitScript() *should*
// make this unnecessary on its own, but a site doing an internal redirect
// or replacing the document in a way that doesn't cleanly re-fire it can
// leave window.__abMoveCursorTo undefined - this guarantees it exists
// regardless of why that happened.
async function moveCursorToElement(page, selector, timeoutMs = 15000) {
  const el = await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.evaluate(cursorInitScript);
  const box = await el.boundingBox();
  if (!box) return; // element matched but isn't visible/laid out - nothing to point at
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => window.__abMoveCursorTo(x, y, false), center);
  await page.waitForTimeout(450); // let the glide animation actually play out on camera
}

/**
 * Resolves a full device/viewport profile from the options passed to
 * POST /record or POST /sessions. Priority:
 *   1. options.device - exact Playwright device preset name (e.g. "Pixel 5")
 *   2. options.orientation - "vertical" or "horizontal" convenience presets
 *   3. options.width/height alone - plain custom viewport, desktop-like
 *   4. default - horizontal desktop, 1920x1080 @2x (HiDPI/retina)
 *
 * In all cases options.width/height/deviceScaleFactor, if provided,
 * override the corresponding field of whatever preset was chosen.
 */
function resolveDeviceProfile(options = {}) {
  let profile;

  if (options.device && devices[options.device]) {
    profile = { ...devices[options.device] };
  } else if (options.orientation === 'vertical') {
    profile = {
      userAgent: IPHONE_UA,
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    };
  } else if (options.orientation === 'horizontal') {
    profile = {
      userAgent: DESKTOP_UA,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
    };
  } else {
    profile = {
      userAgent: DESKTOP_UA,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
    };
  }

  if (options.width || options.height) {
    profile.viewport = {
      width: options.width || profile.viewport.width,
      height: options.height || profile.viewport.height,
    };
  }
  if (options.deviceScaleFactor) profile.deviceScaleFactor = options.deviceScaleFactor;

  return profile;
}

/**
 * Runs a single action against the page.
 * Supported action types:
 *   { type: 'goto', url, waitUntil? }              // waitUntil defaults to 'load' (full paint), not just DOM-ready
 *   { type: 'wait', ms }                          // simple pause
 *   { type: 'waitForSelector', selector, ms? }     // wait for element, optional timeout
 *   { type: 'click', selector, zoom?, zoomDurationMs?, zoomHoldMs?, zoomOut? }
 *   { type: 'type', selector, text, delayMs?, zoom?, zoomDurationMs?, zoomHoldMs?, zoomOut? }
 *   { type: 'search', selector?, text, zoom?, zoomDurationMs?, zoomHoldMs?, zoomOut? }
 *   { type: 'scroll', pixels, durationMs? }        // smooth-scrolls by pixels over durationMs (default: instant-ish steps)
 *   { type: 'pressKey', key }                      // e.g. 'Enter', 'Escape'
 *   { type: 'highlight', selector, color?, durationMs? }  // draws a colored box around an element briefly
 *   { type: 'screenshot', filename?, fullPage? }   // saves a still PNG alongside the video
 *   { type: 'zoomIn', selector, scale?, durationMs? }   // CSS-transform zoom-in centered on an element (camera push-in)
 *   { type: 'zoomOut', durationMs? }               // reverses zoomIn back to scale(1)
 *
 * `zoom` on click/type/search is shorthand for: zoom in on that element,
 * perform the action, briefly hold (zoomHoldMs, default 400ms), then zoom
 * back out (unless zoomOut: false, e.g. if you want to stay zoomed in for
 * a following action).
 */
async function runAction(page, action) {
  const { type } = action;

  switch (type) {
    case 'goto': {
      // 'load' waits for the full load event (images/CSS/fonts included),
      // not just DOM-ready - this is what actually reduces the blank/white
      // time at the start of a recording. Still not "pixel perfect fully
      // painted" for every site (some content loads async after 'load'
      // too), which is why runRecordingJob also trims by measured duration
      // as a second layer of defense.
      await page.goto(action.url, { waitUntil: action.waitUntil || 'load', timeout: action.timeoutMs || 30000 });
      break;
    }

    case 'wait': {
      await page.waitForTimeout(action.ms || 1000);
      break;
    }

    case 'waitForSelector': {
      await page.waitForSelector(action.selector, { timeout: action.ms || 15000 });
      break;
    }

    case 'click': {
      if (action.zoom) await zoomToElement(page, action.selector, action.zoom, action.zoomDurationMs);
      await moveCursorToElement(page, action.selector, action.timeoutMs);
      await page.click(action.selector, { timeout: action.timeoutMs || 15000 });
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs || 400); // brief hold on the clicked result before pulling back out
        await zoomReset(page, action.zoomDurationMs);
      }
      break;
    }

    case 'type': {
      if (action.zoom) await zoomToElement(page, action.selector, action.zoom, action.zoomDurationMs);
      await moveCursorToElement(page, action.selector, action.timeoutMs);
      await page.fill(action.selector, ''); // clear first
      await page.type(action.selector, action.text, { delay: action.delayMs || 30 });
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs || 400);
        await zoomReset(page, action.zoomDurationMs);
      }
      break;
    }

    case 'search': {
      const selector = action.selector || 'input[type="search"], input[name="s"], textarea[name="q"], input[name="q"]';
      if (action.zoom) await zoomToElement(page, selector, action.zoom, action.zoomDurationMs);
      await moveCursorToElement(page, selector);
      await page.click(selector);
      await page.type(selector, action.text, { delay: action.delayMs || 40 });
      await page.keyboard.press('Enter');
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs || 400);
        await zoomReset(page, action.zoomDurationMs);
      }
      break;
    }

    case 'pressKey': {
      await page.keyboard.press(action.key);
      break;
    }

    // Standalone zoom control, for zooming on any area independent of a
    // click/search - e.g. to linger on a chart or a piece of text.
    case 'zoomIn': {
      await zoomToElement(page, action.selector, action.scale || 1.5, action.durationMs || 600);
      break;
    }

    case 'zoomOut': {
      await zoomReset(page, action.durationMs || 600);
      break;
    }

    case 'scroll': {
      const pixels = action.pixels || 1000;
      const durationMs = action.durationMs || 2000;
      const steps = Math.max(5, Math.floor(durationMs / 100));
      const stepSize = pixels / steps;
      const stepDelay = durationMs / steps;

      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, stepSize);
        await page.waitForTimeout(stepDelay);
      }
      break;
    }

    // Draws a colored box around an element for a moment before continuing.
    // Useful so you (or a viewer) can see exactly what's about to be
    // clicked, rather than the click just silently happening off-screen.
    case 'highlight': {
      const color = action.color || '#ff3b30';
      const durationMs = action.durationMs || 800;
      const el = await page.waitForSelector(action.selector, { timeout: action.timeoutMs || 15000 });
      const box = await el.boundingBox();
      if (box) {
        await page.evaluate(({ box, color }) => {
          const div = document.createElement('div');
          div.setAttribute('data-autobrowse-highlight', 'true');
          Object.assign(div.style, {
            position: 'fixed',
            left: `${box.x - 4}px`,
            top: `${box.y - 4}px`,
            width: `${box.width + 8}px`,
            height: `${box.height + 8}px`,
            border: `3px solid ${color}`,
            borderRadius: '6px',
            boxShadow: `0 0 0 3px ${color}33`,
            zIndex: 2147483647,
            pointerEvents: 'none',
          });
          document.body.appendChild(div);
        }, { box, color });
      }
      await page.waitForTimeout(durationMs);
      await page.evaluate(() => {
        document.querySelectorAll('[data-autobrowse-highlight]').forEach((el) => el.remove());
      });
      break;
    }

    // Saves a still PNG into the job's directory (in addition to the video).
    // action._jobDir and action._onScreenshot are injected by runRecordingJob,
    // not something the caller needs to supply.
    case 'screenshot': {
      const filename = action.filename || `screenshot-${Date.now()}.png`;
      const filePath = path.join(action._jobDir, filename);
      await page.screenshot({ path: filePath, fullPage: action.fullPage || false });
      if (typeof action._onScreenshot === 'function') action._onScreenshot(filename);
      break;
    }

    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

/**
 * Runs a full job: launches a stealth Chromium instance, records the browser
 * context to .webm, executes the action list in order, then converts to .mp4.
 *
 * Important: if an action fails partway (e.g. a selector no longer matches
 * after a site redesign), this does NOT throw and discard everything - it
 * still finalizes and converts whatever was recorded up to that point, and
 * returns { outputPath, screenshots, actionError }. That way a broken
 * selector gets you a partial video showing exactly where it broke, instead
 * of nothing at all. There is no self-healing/relearning of selectors - if
 * one breaks, you (or an agent) update the action list based on what the
 * partial video/screenshots show, same as any other code fix.
 *
 * Options accepted (all optional):
 *   options.orientation: "vertical" | "horizontal"  - convenience device presets
 *   options.device: exact Playwright device preset name, e.g. "Pixel 5"
 *   options.width / options.height: override viewport dimensions
 *   options.deviceScaleFactor: override pixel density (2 = retina; higher = sharper but heavier)
 *
 * onLog(line) is called with progress strings for storage in job metadata.
 */
async function runRecordingJob({ actions, options = {}, jobDir, onLog = () => {}, storageStatePath = null }) {
  const deviceProfile = resolveDeviceProfile(options);

  fs.mkdirSync(jobDir, { recursive: true });

  onLog(`Launching headless Chromium (stealth), viewport ${deviceProfile.viewport.width}x${deviceProfile.viewport.height} @${deviceProfile.deviceScaleFactor}x`);
  const browser = await chromium.launch({ headless: true });

  const contextOptions = {
    ...deviceProfile,
    // Video is recorded at the same logical size as the viewport. Chromium
    // still renders internally at deviceScaleFactor resolution, so text and
    // edges come out anti-aliased/sharper than a flat 1x capture even
    // though the final pixel dimensions match the viewport.
    recordVideo: { dir: jobDir, size: deviceProfile.viewport },
  };
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    onLog('Reusing saved session cookies');
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(cursorInitScript); // re-injects on every goto/navigation, not just the first page load

  const screenshots = [];
  let actionError = null;
  let failedAtIndex = null;
  let leadingLoadMs = 0;
  // Once a non-goto, non-wait action happens, the "settling in" period is
  // over and nothing further gets trimmed - this only ever covers a
  // contiguous prefix at the very start of the action list.
  let stillInLeadingPrefix = true;
  const trimLeadingWaits = options.trimLeadingWaits !== false; // opt-out via options.trimLeadingWaits: false

  for (const [i, action] of actions.entries()) {
    onLog(`Action ${i + 1}/${actions.length}: ${action.type}`);
    try {
      // Inject job dir + screenshot tracking without requiring the caller to know about it.
      const enrichedAction = action.type === 'screenshot'
        ? { ...action, _jobDir: jobDir, _onScreenshot: (name) => screenshots.push(name) }
        : action;

      const isLeadingGoto = i === 0 && action.type === 'goto';
      const isLeadingWait = stillInLeadingPrefix && i > 0 && action.type === 'wait' && trimLeadingWaits;

      if (isLeadingGoto || isLeadingWait) {
        const start = Date.now();
        await runAction(page, enrichedAction);
        leadingLoadMs += Date.now() - start;
      } else {
        stillInLeadingPrefix = false; // first non-goto/non-wait action ends the trimmable prefix
        await runAction(page, enrichedAction);
      }
    } catch (err) {
      actionError = err.message;
      failedAtIndex = i;
      onLog(`Action ${i + 1} FAILED: ${err.message} - stopping here, finalizing partial recording`);
      break; // stop executing further actions, but still fall through to finalize below
    }
  }

  onLog('Finalizing recording');
  const video = page.video();
  await context.close();
  await browser.close();

  const webmPath = video ? await video.path() : null;
  if (!webmPath || !fs.existsSync(webmPath)) {
    throw new Error('Recording failed: no video file was produced');
  }

  const mp4Path = path.join(jobDir, 'output.mp4');
  // Trim off the initial page-load time so the video starts once the site
  // has actually rendered, instead of a few seconds of blank tab. Small
  // buffer subtracted so we don't cut into the very first visible frame.
  const trimSeconds = leadingLoadMs > 300 ? Math.max(0, (leadingLoadMs - 150) / 1000) : 0;
  onLog(trimSeconds > 0
    ? `Converting webm -> mp4 (trimming ${trimSeconds.toFixed(2)}s of initial load time)`
    : 'Converting webm -> mp4');
  await convertToMp4(webmPath, mp4Path, trimSeconds);
  fs.unlink(webmPath, () => {}); // clean up the intermediate webm now that we have the mp4

  return { outputPath: mp4Path, screenshots, actionError, failedAtIndex };
}

/**
 * Converts the raw .webm recording to .mp4, optionally trimming
 * `trimSeconds` off the start. -ss is placed AFTER -i (an "output" seek)
 * so the cut is frame-accurate rather than snapping to the nearest
 * keyframe - important since we're only trimming a second or two.
 *
 * Quality settings: crf 16 + preset "slow" prioritize sharpness over encode
 * speed. This is noticeably slower than "medium"/crf 18 on a CPU-only VPS -
 * a 30s clip that took ~15-20s to encode at medium/18 may take closer to
 * 40-60s at slow/16. If jobs start queuing up badly under load, "medium"
 * is the first lever to pull back; crf 16 is close to visually lossless
 * for screen-recording-style content, so there's little to gain going lower.
 */
function convertToMp4(inputPath, outputPath, trimSeconds = 0) {
  const args = ['-y', '-i', inputPath];
  if (trimSeconds > 0) args.push('-ss', trimSeconds.toFixed(3));
  args.push(
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    outputPath
  );

  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
      resolve(outputPath);
    });
  });
}

/**
 * Runs a one-off login (or any action list) with NO video recording, then
 * saves the resulting cookies/localStorage to storageStatePath. The actual
 * credentials passed in `actions` (e.g. a `type` action filling a password
 * field) are used only in-memory for this single run and are never written
 * to disk or logged. Only the resulting session state is persisted.
 */
async function createSession({ actions, options = {}, storageStatePath, onLog = () => {} }) {
  const deviceProfile = resolveDeviceProfile(options);

  onLog('Launching headless Chromium (stealth) for one-off session login');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(deviceProfile);
  const page = await context.newPage();

  try {
    for (const [i, action] of actions.entries()) {
      // Deliberately do NOT log action payloads here (they may contain
      // a password in a `type` action) — only the type/index.
      onLog(`Session action ${i + 1}/${actions.length}: ${action.type}`);
      await runAction(page, action);
    }
    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
    onLog('Session saved');
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { runRecordingJob, createSession };
