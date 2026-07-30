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
    void el.offsetHeight; // force the transition to commit before the transform below changes it (see zoomToElement for why)
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
}

// Zooms the whole page in on an already-resolved element `box` by applying
// a CSS scale transform with its origin centered on that element - like a
// camera push-in. This affects layout visually only (the transform doesn't
// change actual DOM geometry beyond what CSS transforms always do), and
// Playwright's own click()/evaluate() hit-testing correctly accounts for
// the transform, so clicking after a zoom still targets the right (now
// larger) element.
//
// Takes a `box` (from resolveVisibleElement) rather than a selector: click/
// type/search have already resolved their target once and pass that same
// box straight through, so the DOM is only ever queried once per action.
// Re-resolving the selector a second time here used to make it possible for
// the same selector to answer differently across the two calls (e.g. a
// hover-triggered menu changing the DOM between the first resolution and
// this one), which could zoom in on the wrong element than the one about
// to be clicked/typed into.
//
// KNOWN LIMITATION: CSS `transform` on an ancestor creates a new
// containing block for any `position: fixed` descendant (e.g. a sticky
// nav header), so such elements can visibly shift or misplace during a
// zoom. The CSS `zoom` property doesn't have this side effect, but it
// also doesn't support `transform-origin` at all - meaning it can only
// ever scale from the page's top-left corner, not center on the target
// element, which would break the actual point of this feature on every
// single use rather than just on pages with sticky headers. Given that
// trade-off, this keeps `transform: scale` (accurate centered zoom,
// occasional sticky-header glitch) over `zoom` (correct on sticky headers,
// wrong centering always).
async function zoomToElement(page, box, scale = 1.5, durationMs = 600) {
  if (!box) return; // nothing resolved - nothing to zoom to

  // `box` comes from getBoundingClientRect() (via Playwright's boundingBox()),
  // which is VIEWPORT-relative. CSS `transform-origin` percentages, though,
  // are relative to the transformed element's OWN border box - and since the
  // transform is applied to document.documentElement (<html>), that box is
  // sized to the full scrollable DOCUMENT, not the viewport. On any page
  // taller than one screen (i.e. almost every real page), computing the
  // origin as a percentage of viewport dimensions silently anchors the scale
  // to the wrong point - which can shove the very element being zoomed to
  // right off-screen, causing the click that follows to fail with "element
  // is outside of the viewport" even though resolveVisibleElement just
  // confirmed it was on-screen a moment earlier (before this ran).
  //
  // Pixel-based transform-origin sidesteps the ambiguity: it's the same
  // unit regardless of which box it's relative to, as long as it's
  // expressed in DOCUMENT coordinates - so the viewport-relative box needs
  // the current scroll offset added back in.
  const { scrollX, scrollY } = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
  const originXpx = scrollX + box.x + box.width / 2;
  const originYpx = scrollY + box.y + box.height / 2;

  await page.evaluate(({ originXpx, originYpx, scale, durationMs }) => {
    const html = document.documentElement;
    html.style.transition = `transform ${durationMs}ms ease-in-out`;
    html.style.transformOrigin = `${originXpx}px ${originYpx}px`;
    // Force the browser to commit the style recalc for the lines above
    // BEFORE the transform value below changes. Setting `transition` and
    // then changing the property it applies to in the same synchronous
    // block can get coalesced into a single style recalc by the browser -
    // which skips the animation entirely and jumps straight to the end
    // state instead of tweening through it (reads as an instant snap, not
    // a smooth zoom). Reading a layout property forces a synchronous
    // reflow, which commits everything queued so far as its own frame.
    void html.offsetHeight;
    html.style.transform = `scale(${scale})`;
    html.style.overflow = 'hidden'; // avoid scrollbars/edge artifacts while zoomed
  }, { originXpx, originYpx, scale, durationMs });
  await page.waitForTimeout(durationMs);
}

// Reverses zoomToElement back to scale(1), same transition duration.
//
// Defensively tolerates the page having navigated out from under it (see
// settleAfterPossibleNavigation below for the normal case this guards
// against) - if the execution context is gone, there's nothing to reset:
// whatever new page just loaded doesn't have this zoom transform applied
// in the first place, so the "reset" is trivially already true.
async function zoomReset(page, durationMs = 600) {
  try {
    await page.evaluate((durationMs) => {
      const html = document.documentElement;
      html.style.transition = `transform ${durationMs}ms ease-in-out`;
      void html.offsetHeight; // force the transition to commit before the transform below changes it
      html.style.transform = 'scale(1)';
    }, durationMs);
    await page.waitForTimeout(durationMs);
    await page.evaluate(() => {
      document.documentElement.style.overflow = '';
    });
  } catch (err) {
    if (!/Execution context was destroyed|Target (page|closed|crashed)|has been closed/i.test(err.message)) throw err;
  }
}

// Click and search (via Enter) can both legitimately trigger a full page
// navigation - a link, a submit button, a search box. When that happens,
// the OLD page's execution context is torn down, and anything that runs
// next (the caller's own zoom-out step, or worse, the NEXT action in the
// list resolving a selector on what it assumes is still the same page)
// hits a confusing "Execution context was destroyed" error - even though
// the navigation itself was the intended, correct outcome of the action.
//
// This gives a just-triggered navigation a bounded window to finish before
// control returns to the caller. It's a genuine no-op when nothing
// navigated: page.waitForLoadState() resolves immediately if the page is
// already in (or past) the requested state, which is normal for actions
// that don't cause a page change (e.g. an in-place UI toggle, a same-page
// anchor click, an AJAX/SPA-style search that never does a full reload).
async function settleAfterPossibleNavigation(page, timeoutMs = 10000) {
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
}

// Thin wrapper for the standalone `zoomIn` action, which (unlike click/
// type/search) has no already-resolved box to hand zoomToElement - it has
// to resolve the selector itself first.
async function zoomToSelector(page, selector, scale = 1.5, durationMs = 600) {
  const { box } = await resolveVisibleElement(page, selector);
  await zoomToElement(page, box, scale, durationMs);
}

// Resolves `selector` to the first match that Playwright's OWN
// actionability engine considers genuinely clickable - visible, stable,
// enabled, and not obscured or clipped by an ancestor.
//
// An earlier version of this function tried to reimplement "is this
// really on-screen" by comparing boundingBox() coordinates against the
// viewport dimensions directly. That's not good enough: it doesn't
// account for things like an off-canvas mobile-menu panel sitting inside
// an `overflow: hidden` ancestor, or a parent `transform: translateX(...)`
// pushing content out of view while the element's OWN box coordinates
// still look nominally on-screen. Playwright's real actionability checks
// already handle all of this correctly (proven by its own error logs
// literally saying "element is outside of the viewport" for exactly the
// element this used to wrongly accept) - so this now uses that engine
// directly via `{ trial: true }`, which runs every actionability check a
// real click would but stops short of actually performing it.
//
// This is the single source of truth for "which element did the caller
// actually mean" - click, type, search, zoomIn, and highlight all resolve
// through this ONE function so they can never disagree about which of
// several matches is the real one, and each only resolves the DOM once
// per action instead of Playwright's own click()/fill() re-resolving the
// selector a second time independently.
async function resolveVisibleElement(page, selector, timeoutMs = 15000) {
  await page.waitForSelector(selector, { timeout: timeoutMs }); // throws if NOTHING matches at all
  const candidates = await page.locator(selector).all();

  // Short fast-fail probe per candidate (not a slice of timeoutMs) - a
  // genuinely actionable element passes almost instantly, and a bad one
  // should be ruled out quickly rather than eating a large chunk of the
  // overall budget before moving to the next candidate.
  const PROBE_TIMEOUT_MS = 1500;

  let lastError = null;

  for (const locator of candidates) {
    try {
      // `trial: true` only checks visible/stable/enabled/receives-events AT
      // THE ELEMENT'S CURRENT POSITION - it does NOT guarantee the element
      // is actually inside the current viewport. An element sitting inside
      // an off-canvas panel (e.g. a slide-in mobile menu hidden via
      // `transform: translateX(...)` rather than display:none) can pass
      // this trial cleanly and then hang for the caller's full click
      // timeout later, retrying scrollIntoViewIfNeeded forever on something
      // no scroll can ever bring on-screen. So: explicitly scroll it into
      // view and re-check its box against the real viewport dimensions
      // before trusting this candidate - if it's still off-canvas after
      // that, treat it as a failed candidate and move on, exactly like any
      // other actionability failure.
      await locator.click({ trial: true, timeout: PROBE_TIMEOUT_MS });
      await locator.scrollIntoViewIfNeeded({ timeout: PROBE_TIMEOUT_MS });
      const box = await locator.boundingBox();
      if (!box) continue;

      const viewport = page.viewportSize();
      const fitsViewport = box.x >= -1 && box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1;
      if (!fitsViewport) {
        lastError = new Error(`matched element's box (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}) falls outside the ${viewport.width}x${viewport.height} viewport - likely an off-canvas/hidden-menu clone`);
        continue;
      }

      return { locator, box };
    } catch (err) {
      // A closed page/context isn't "this candidate wasn't actionable" -
      // it's the browser going away mid-check (crash, unexpected
      // navigation away, external context.close()). No other candidate is
      // going to fare any better, and swallowing this into the generic
      // "none passed" message below would hide the actual cause.
      if (/has been closed|Target (page|closed|crashed)/i.test(err.message)) throw err;
      lastError = err; // this candidate failed Playwright's own actionability check - try the next one
      continue;
    }
  }

  const detail = lastError ? ` Last candidate failure: ${String(lastError.message).split('\n')[0]}` : '';
  throw new Error(`Selector "${selector}" matched ${candidates.length} element(s), but none passed Playwright's actionability + viewport check (all hidden, off-screen, clipped by a parent, or obscured).${detail}`);
}

// Moves the fake cursor to the center of `selector` (given an already-
// resolved box - see resolveVisibleElement) and waits for the glide
// animation to finish, so the click/type that follows visibly lines up
// with where the cursor just arrived.
//
// Defensively re-runs cursorInitScript() via page.evaluate right before use
// (it's idempotent - the early "already exists" check inside it makes this
// a no-op if the cursor is already there). page.addInitScript() *should*
// make this unnecessary on its own, but a site doing an internal redirect
// or replacing the document in a way that doesn't cleanly re-fire it can
// leave window.__abMoveCursorTo undefined - this guarantees it exists
// regardless of why that happened.
async function moveCursorToBox(page, box) {
  await page.evaluate(cursorInitScript);
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
      await page.goto(action.url, { waitUntil: action.waitUntil || 'load', timeout: action.timeoutMs ?? 30000 });
      break;
    }

    case 'wait': {
      await page.waitForTimeout(action.ms ?? 1000);
      break;
    }

    case 'waitForSelector': {
      await page.waitForSelector(action.selector, { timeout: action.ms ?? 15000 });
      break;
    }

    case 'click': {
      const { locator, box } = await resolveVisibleElement(page, action.selector, action.timeoutMs);
      if (action.zoom) await zoomToElement(page, box, action.zoom, action.zoomDurationMs);
      await moveCursorToBox(page, box);
      // resolveVisibleElement already ran a trial + scroll + viewport check
      // for this exact locator, so a short timeout here is just a safety
      // margin for the real click - not another full wait budget. Keeps a
      // genuinely broken action from silently eating 30s (15s resolve +
      // 15s click) before the job gives up.
      await locator.click({ timeout: action.timeoutMs ?? 5000 });
      await settleAfterPossibleNavigation(page);
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs ?? 400); // brief hold on the clicked result before pulling back out
        await zoomReset(page, action.zoomDurationMs);
      }
      break;
    }

    case 'type': {
      const { locator, box } = await resolveVisibleElement(page, action.selector, action.timeoutMs);
      if (action.zoom) await zoomToElement(page, box, action.zoom, action.zoomDurationMs);
      await moveCursorToBox(page, box);
      await locator.fill(''); // clear first
      await locator.pressSequentially(action.text, { delay: action.delayMs ?? 30 });
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs ?? 400);
        await zoomReset(page, action.zoomDurationMs);
      }
      break;
    }

    case 'search': {
      const selector = action.selector || 'input[type="search"], input[name="s"], textarea[name="q"], input[name="q"]';
      const { locator, box } = await resolveVisibleElement(page, selector);
      if (action.zoom) await zoomToElement(page, box, action.zoom, action.zoomDurationMs);
      await moveCursorToBox(page, box);
      await locator.click();
      await locator.pressSequentially(action.text, { delay: action.delayMs ?? 40 });
      await page.keyboard.press('Enter');
      await settleAfterPossibleNavigation(page);
      if (action.zoom && action.zoomOut !== false) {
        await page.waitForTimeout(action.zoomHoldMs ?? 400);
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
      await zoomToSelector(page, action.selector, action.scale ?? 1.5, action.durationMs ?? 600);
      break;
    }

    case 'zoomOut': {
      await zoomReset(page, action.durationMs ?? 600);
      break;
    }

    case 'scroll': {
      const pixels = action.pixels ?? 1000;
      const durationMs = action.durationMs ?? 2000;
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
      const durationMs = action.durationMs ?? 800;
      const { box } = await resolveVisibleElement(page, action.selector, action.timeoutMs);
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

      // Optional still capture WHILE the highlight is visible, before this
      // action's own cleanup removes it below. A separate `screenshot`
      // action run right after `highlight` would always show the overlay
      // already gone - each action's cleanup runs to completion before the
      // next action starts, so there's no window for a later action to
      // catch it. Set `captureScreenshot: true` here instead of relying on
      // a follow-up screenshot action, for exactly this reason.
      if (action.captureScreenshot) {
        const filename = action.screenshotFilename || `highlight-${Date.now()}.png`;
        const filePath = path.join(action._jobDir, filename);
        await page.screenshot({ path: filePath, fullPage: action.fullPage || false });
        if (typeof action._onScreenshot === 'function') action._onScreenshot(filename);
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
 * onActionError(message, failedAtIndex) is called THE MOMENT an action
 * fails - before the (potentially slow, "slow"/crf16) ffmpeg conversion of
 * the partial video even starts. This is what lets the caller report an
 * error immediately instead of waiting for encoding to finish first, same
 * as the render server's fail-fast philosophy - the difference here is
 * that AutoBrowse can still recover a partial video afterward, so instead
 * of also throwing everything away, encoding still proceeds in the
 * background and the caller can send a follow-up update once
 * outputPath is ready.
 */
async function runRecordingJob({ actions, options = {}, jobDir, onLog = () => {}, storageStatePath = null, onActionError = () => {} }) {
  const deviceProfile = resolveDeviceProfile(options);

  fs.mkdirSync(jobDir, { recursive: true });

  onLog(`Launching headless Chromium (stealth), viewport ${deviceProfile.viewport.width}x${deviceProfile.viewport.height} @${deviceProfile.deviceScaleFactor}x`);
  const browser = await chromium.launch({ headless: true });

  const contextOptions = {
    ...deviceProfile,
    // Video output is captured at PHYSICAL pixel dimensions (viewport x
    // deviceScaleFactor), not the logical viewport size. Chromium already
    // renders internally at the higher density regardless (that's what
    // deviceScaleFactor does), but Playwright's recordVideo.size caps the
    // OUTPUT video to whatever size is given here - leaving it at the
    // logical viewport size was silently downsampling every recording back
    // down to 1x, throwing away the sharper detail Chromium had already
    // rendered. This matters a lot for footage that gets cropped/zoomed
    // inside a Remotion composition afterward - extra source resolution is
    // the difference between a clean crop and a visibly soft one.
    // Trade-off: roughly 4x the pixel count of a 1x capture (2x width x 2x
    // height), so meaningfully bigger files and longer ffmpeg encodes.
    recordVideo: {
      dir: jobDir,
      size: {
        width: Math.round(deviceProfile.viewport.width * (deviceProfile.deviceScaleFactor || 1)),
        height: Math.round(deviceProfile.viewport.height * (deviceProfile.deviceScaleFactor || 1)),
      },
    },
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
      // Inject job dir + screenshot tracking without requiring the caller to
      // know about it - needed for plain `screenshot` actions, and for
      // `highlight` actions that opt into `captureScreenshot`.
      const needsScreenshotContext = action.type === 'screenshot'
        || (action.type === 'highlight' && action.captureScreenshot);
      const enrichedAction = needsScreenshotContext
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
      onActionError(err.message, i); // fire immediately - don't wait for the conversion below
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

// Extracts a pruned, planner-friendly summary of a page's interactive
// elements - links (text + href), buttons, inputs, and images (alt text) -
// so an action-planning LLM can generate selectors grounded in the page's
// ACTUAL rendered DOM instead of guessing from the page's name/URL/general
// knowledge of what a site like this "probably" looks like. Same fix in
// spirit as feeding a scene planner a live clone of available components
// instead of letting it guess from memory: ground the planner in reality
// BEFORE it plans, not after a selector fails.
//
// Deliberately does NOT return raw HTML: a full page's markup is far more
// tokens than a planner needs, and buries the handful of elements that
// actually matter (interactive ones) inside thousands of layout/decorative
// nodes. A flat, pre-filtered, de-duplicated list keeps the planner's
// prompt small and focused on exactly what it can act on.
//
// Runs through the same stealth-launched browser as recording jobs (same
// UA/viewport handling via resolveDeviceProfile) and accepts the same
// storageStatePath as runRecordingJob, so a saved session (POST
// /sessions) works identically here - inspecting a page that requires
// sign-in sees the same authenticated DOM the actual recording job would.
//
// `steps` (optional): a chain of navigation-only actions (goto/click/
// scroll/waitForSelector/pressKey/search/zoomIn/zoomOut - not screenshot or
// a highlight with captureScreenshot, since inspection has no job
// directory to save files into) run in sequence on the SAME page/session
// AFTER the initial goto, with a fresh snapshot taken after every single
// step - not just once at the end. This is what makes a "click a button,
// see what's on the next page" flow inspectable: without it, only the
// starting page is ever grounded in real data, and every selector for
// anything reached by clicking through is still a guess. Each entry in the
// returned `pages` array is one step's resulting page state; a step that
// fails stops the chain there (same "return what's real so far, don't
// throw everything away" philosophy as a recording job's action failures)
// rather than either skipping it or aborting the whole request.
async function inspectPage({ url, steps = [], options = {}, storageStatePath = null, maxElementsPerType = 60 }) {
  const deviceProfile = resolveDeviceProfile(options);
  const browser = await chromium.launch({ headless: true });

  const contextOptions = { ...deviceProfile };
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  async function snapshotCurrentPage() {
    // Give lazy-loaded/hydrating content a brief window to settle - a
    // snapshot taken mid-hydration would reproduce the exact "looks empty
    // until scrolled into view" gap that caused the selector failures this
    // endpoint exists to prevent.
    await page.waitForTimeout(1000);

    const summary = await page.evaluate((maxElementsPerType) => {
      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function shortText(el) {
        return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || undefined;
      }
      // Collects up to maxElementsPerType visible matches, collapsing exact
      // duplicates - real pages commonly repeat the same link/product
      // across multiple sections (e.g. a homepage's "Latest Arrivals" AND
      // "Top Picks" both listing the same item), and the planner only
      // needs to see it once to know it exists.
      function pick(selectorList, mapFn) {
        const seen = new Set();
        const out = [];
        for (const el of document.querySelectorAll(selectorList)) {
          if (out.length >= maxElementsPerType) break;
          if (!isVisible(el)) continue;
          const item = mapFn(el);
          const key = JSON.stringify(item);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
        return out;
      }

      return {
        title: document.title,
        links: pick('a[href]', (el) => ({ text: shortText(el), href: el.href, id: el.id || undefined })),
        buttons: pick('button, [role="button"], input[type="submit"], input[type="button"]', (el) => ({
          text: shortText(el) || el.value || el.getAttribute('aria-label') || undefined,
          id: el.id || undefined,
        })),
        inputs: pick('input:not([type="hidden"]), textarea, select', (el) => ({
          type: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
          name: el.name || undefined,
          id: el.id || undefined,
          placeholder: el.placeholder || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
        })),
        images: pick('img[alt]:not([alt=""])', (el) => ({ alt: el.alt, src: el.currentSrc || el.src })),
      };
    }, maxElementsPerType);

    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    return { url: page.url(), pageHeight, viewport: deviceProfile.viewport, ...summary };
  }

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const pages = [{ step: 0, action: { type: 'goto', url }, ...(await snapshotCurrentPage()) }];

    for (const [i, step] of steps.entries()) {
      try {
        await runAction(page, step); // same click/scroll/waitForSelector/etc logic a real recording uses
        pages.push({ step: i + 1, action: step, ...(await snapshotCurrentPage()) });
      } catch (err) {
        pages.push({ step: i + 1, action: step, error: err.message });
        break; // can't meaningfully keep inspecting past a step that didn't actually happen
      }
    }

    // Top-level fields mirror the last page reached, for backward
    // compatibility with a caller that only passes a bare `url` (no
    // `steps`) and expects the original single-page response shape.
    // `pages` is always present (exactly one entry when no steps were
    // given) and is where a multi-step chain's full journey lives.
    return { ...pages[pages.length - 1], pages };
  } finally {
    await browser.close();
  }
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

module.exports = { runRecordingJob, createSession, inspectPage };
