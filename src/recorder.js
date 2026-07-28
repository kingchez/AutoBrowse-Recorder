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

    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

/**
 * Runs a full job: launches a stealth Chromium instance, records the browser
 * context to .webm, executes the action list in order, then converts to .mp4.
 *
 * onLog(line) is called with progress strings for storage in job metadata.
 */
async function runRecordingJob({ actions, options = {}, jobDir, onLog = () => {} }) {
  const viewport = {
    width: options.width || DEFAULT_VIEWPORT.width,
    height: options.height || DEFAULT_VIEWPORT.height,
  };

  fs.mkdirSync(jobDir, { recursive: true });

  onLog('Launching headless Chromium (stealth)');
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: jobDir, size: viewport },
  });

  const page = await context.newPage();

  try {
    for (const [i, action] of actions.entries()) {
      onLog(`Action ${i + 1}/${actions.length}: ${action.type}`);
      await runAction(page, action);
    }
  } finally {
    // Video only finalizes once the context (and its page) close.
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

    // Clean up the intermediate webm now that we have the mp4
    fs.unlink(webmPath, () => {});

    return mp4Path;
  }
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

module.exports = { runRecordingJob };
