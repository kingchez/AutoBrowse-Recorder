const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Runs a single action against the page.
 * Supported action types:
 *   { type: 'goto', url }
 *   { type: 'wait', ms }                          // simple pause
 *   { type: 'waitForSelector', selector, ms? }     // wait for element, optional timeout
 *   { type: 'click', selector }
 *   { type: 'type', selector, text, delayMs? }
 *   { type: 'search', selector?, text }            // types into selector (or common search inputs) + presses Enter
 *   { type: 'scroll', pixels, durationMs? }        // smooth-scrolls by pixels over durationMs (default: instant-ish steps)
 *   { type: 'pressKey', key }                      // e.g. 'Enter', 'Escape'
 *   { type: 'highlight', selector, color?, durationMs? }  // draws a colored box around an element briefly
 *   { type: 'screenshot', filename?, fullPage? }   // saves a still PNG alongside the video
 */
async function runAction(page, action) {
  const { type } = action;

  switch (type) {
    case 'goto': {
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: action.timeoutMs || 30000 });
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
      await page.click(action.selector, { timeout: action.timeoutMs || 15000 });
      break;
    }

    case 'type': {
      await page.fill(action.selector, ''); // clear first
      await page.type(action.selector, action.text, { delay: action.delayMs || 30 });
      break;
    }

    case 'search': {
      const selector = action.selector || 'input[type="search"], textarea[name="q"], input[name="q"]';
      await page.waitForSelector(selector, { timeout: 15000 });
      await page.click(selector);
      await page.type(selector, action.text, { delay: action.delayMs || 40 });
      await page.keyboard.press('Enter');
      break;
    }

    case 'pressKey': {
      await page.keyboard.press(action.key);
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
      await page.waitForSelector(action.selector, { timeout: action.timeoutMs || 15000 });
      await page.evaluate(({ selector, color }) => {
        const el = document.querySelector(selector);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const box = document.createElement('div');
        box.setAttribute('data-autobrowse-highlight', 'true');
        Object.assign(box.style, {
          position: 'fixed',
          left: `${rect.left - 4}px`,
          top: `${rect.top - 4}px`,
          width: `${rect.width + 8}px`,
          height: `${rect.height + 8}px`,
          border: `3px solid ${color}`,
          borderRadius: '6px',
          boxShadow: `0 0 0 3px ${color}33`,
          zIndex: 2147483647,
          pointerEvents: 'none',
        });
        document.body.appendChild(box);
      }, { selector: action.selector, color });
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
 * onLog(line) is called with progress strings for storage in job metadata.
 */
async function runRecordingJob({ actions, options = {}, jobDir, onLog = () => {}, storageStatePath = null }) {
  const viewport = {
    width: options.width || DEFAULT_VIEWPORT.width,
    height: options.height || DEFAULT_VIEWPORT.height,
  };

  fs.mkdirSync(jobDir, { recursive: true });

  onLog('Launching headless Chromium (stealth)');
  const browser = await chromium.launch({ headless: true });

  const contextOptions = {
    viewport,
    recordVideo: { dir: jobDir, size: viewport },
  };
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    onLog('Reusing saved session cookies');
    contextOptions.storageState = storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const screenshots = [];
  let actionError = null;
  let failedAtIndex = null;

  for (const [i, action] of actions.entries()) {
    onLog(`Action ${i + 1}/${actions.length}: ${action.type}`);
    try {
      // Inject job dir + screenshot tracking without requiring the caller to know about it.
      const enrichedAction = action.type === 'screenshot'
        ? { ...action, _jobDir: jobDir, _onScreenshot: (name) => screenshots.push(name) }
        : action;
      await runAction(page, enrichedAction);
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
  onLog('Converting webm -> mp4');
  await convertToMp4(webmPath, mp4Path);
  fs.unlink(webmPath, () => {}); // clean up the intermediate webm now that we have the mp4

  return { outputPath: mp4Path, screenshots, actionError, failedAtIndex };
}

function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outputPath],
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
        resolve(outputPath);
      }
    );
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
  const viewport = {
    width: options.width || DEFAULT_VIEWPORT.width,
    height: options.height || DEFAULT_VIEWPORT.height,
  };

  onLog('Launching headless Chromium (stealth) for one-off session login');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
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
