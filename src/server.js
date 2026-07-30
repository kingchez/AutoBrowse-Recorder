const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { runRecordingJob, createSession, inspectPage } = require('./recorder');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const JOBS_ROOT = process.env.JOBS_DIR || path.join(__dirname, '..', 'data', 'jobs');
const SESSIONS_ROOT = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'data', 'sessions');
// Same "days" framing as the render server's AUTO_PRUNE_OLDER_THAN_DAYS, expressed in hours here.
const PRUNE_AFTER_HOURS = Number(process.env.PRUNE_AFTER_HOURS || 48);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

fs.mkdirSync(JOBS_ROOT, { recursive: true });
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

function sessionPathFor(name) {
  // Reject (rather than silently strip) anything outside this safe set -
  // stripping could make two different names collide on the same file
  // (e.g. "a!b" and "ab" would both sanitize to "ab" and silently
  // overwrite each other's saved session).
  if (!/^[a-zA-Z0-9_-]+$/.test(String(name))) {
    throw new Error('Session name must contain only letters, numbers, underscores, and hyphens');
  }
  return path.join(SESSIONS_ROOT, `${name}.json`);
}

function jobDirFor(id) {
  return path.join(JOBS_ROOT, id);
}

// Required fields per action type. Checked BEFORE launching a browser -
// previously a typo'd action (e.g. `click` with no `selector`) wasn't
// caught until deep into a job that had already spent 8+ seconds launching
// Chromium and navigating, surfacing as a confusing Playwright-internal
// error instead of an instant, clear 400.
const REQUIRED_FIELDS_BY_TYPE = {
  goto: ['url'],
  wait: [],
  waitForSelector: ['selector'],
  click: ['selector'],
  type: ['selector', 'text'],
  search: ['text'], // selector is optional (falls back to common search-input selectors)
  scroll: [],
  pressKey: ['key'],
  highlight: ['selector'],
  screenshot: [],
  zoomIn: ['selector'],
  zoomOut: [],
};

function validateActions(actions) {
  const errors = [];
  actions.forEach((action, i) => {
    if (!action || typeof action !== 'object') {
      errors.push(`Action ${i + 1}: must be an object`);
      return;
    }
    const requiredFields = REQUIRED_FIELDS_BY_TYPE[action.type];
    if (requiredFields === undefined) {
      errors.push(`Action ${i + 1}: unknown type "${action.type}"`);
      return;
    }
    for (const field of requiredFields) {
      if (action[field] === undefined || action[field] === null || action[field] === '') {
        errors.push(`Action ${i + 1} (${action.type}): missing required field "${field}"`);
      }
    }
  });
  return errors;
}

// In-memory job registry: id -> { status, log, createdAt, outputPath?, screenshots?, error? }
// status is one of: "pending" | "processing" | "done" | "partial" | "error"
// ("partial" = an action failed but real video exists/is coming; "error" is
// reserved for a hard failure with no video at all, e.g. Chromium never
// launched)
const jobs = new Map();

function cleanup(jobId) {
  const dir = jobDirFor(jobId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
  jobs.delete(jobId);
}

function saveMeta(id) {
  const job = jobs.get(id);
  if (!job) return;
  const dir = jobDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(job, null, 2));
}

// Webhook delivery, matching the render server's fireCallback exactly:
// same payload shape ({ source, job_id, status, output_url?, error? }),
// same 4-attempt / 2s-5s-15s backoff.
//
// IMPORTANT: a successful webhook POST means "the receiver was notified,"
// NOT "the receiver already downloaded the file." Those are different
// events - if this deleted the in-memory job record the instant the
// webhook call returned 200, a receiver that fetches output_url even a
// moment later would get a 404 on a file that's still sitting right there
// on disk. So the job is only ever deleted here when the payload has NO
// output_url at all (nothing will ever be fetchable for this job - e.g. a
// hard failure with no video, or the interim "action just failed" notice
// before encoding finishes). Whenever output_url IS present, deletion is
// left entirely to GET /recordings/:id/output's own consume-on-delivery
// logic (or the hourly prune, if it's never fetched).
const CALLBACK_BACKOFF_MS = [2000, 5000, 15000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fireCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log(`Callback to ${callbackUrl} delivered (job_id=${payload.job_id}, status=${payload.status}) on attempt ${attempt}.`);
        if (!payload.output_url) jobs.delete(payload.job_id); // nothing further will ever be fetchable
        return;
      }
      console.warn(`Callback to ${callbackUrl} returned HTTP ${res.status} on attempt ${attempt}.`);
    } catch (err) {
      console.warn(`Callback to ${callbackUrl} failed on attempt ${attempt}:`, err.message);
    }
    if (attempt < 4) await sleep(CALLBACK_BACKOFF_MS[attempt - 1]);
  }
  console.error(`Callback to ${callbackUrl} failed after 4 attempts (job_id=${payload.job_id}). Giving up - job record kept in memory for manual GET /recordings/${payload.job_id} pull.`);
}

// Defensive wrapper for every fire-and-forget fireCallback call below.
// fireCallback already catches its own realistic failure modes internally,
// so this should never actually trigger - but on Node 18+, an unhandled
// promise rejection kills the entire process by default, meaning a single
// unexpected bug in the callback path could take down every in-flight
// recording, not just the one job reporting it. This guarantees that
// can't happen regardless of what future changes touch fireCallback.
function fireCallbackSafely(callbackUrl, payload) {
  fireCallback(callbackUrl, payload).catch((err) => {
    console.error(`Unexpected error in fireCallback (job_id=${payload.job_id}):`, err.message);
  });
}

// Restart recovery, same idea as the render server: a job's real "done" time
// is its own output.mp4 mtime, not anything we tracked in memory (which is
// gone after a restart). For each job directory on disk:
//   - has output.mp4, still within the prune window -> rehydrate as "done"
//     so GET /recordings/:id/output can still serve it.
//   - has output.mp4, already past the window -> delete it now.
//   - has no output.mp4 at all -> it was mid-job when the process died;
//     nothing to serve, so just remove the leftover directory.
function recoverJobsFromDisk() {
  if (!fs.existsSync(JOBS_ROOT)) return;
  const cutoffMs = PRUNE_AFTER_HOURS * 3600 * 1000;

  for (const id of fs.readdirSync(JOBS_ROOT)) {
    const dir = jobDirFor(id);
    const outputPath = path.join(dir, 'output.mp4');
    const metaPath = path.join(dir, 'meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { /* ignore corrupt meta */ }
    }

    if (!fs.existsSync(outputPath)) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }

    const finishedAtMs = fs.statSync(outputPath).mtimeMs;
    if (Date.now() - finishedAtMs > cutoffMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }

    jobs.set(id, {
      status: meta.actionError ? 'partial' : 'done',
      log: meta.log || [],
      createdAt: meta.createdAt || finishedAtMs,
      outputPath,
      screenshots: meta.screenshots || [],
      error: meta.actionError || undefined,
    });
  }
}
recoverJobsFromDisk();

// POST /record  { actions: [...], options?: {...}, session?: "name", callbackUrl?: "..." }
// Returns immediately with a job id; recording happens async since it's wall-clock bound.
app.post('/record', (req, res) => {
  const { actions, options, session, callbackUrl } = req.body || {};

  if (!Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "actions" array' });
  }

  const actionErrors = validateActions(actions);
  if (actionErrors.length > 0) {
    return res.status(400).json({ error: 'Invalid actions', details: actionErrors });
  }

  let storageStatePath = null;
  if (session) {
    try {
      storageStatePath = sessionPathFor(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(storageStatePath)) {
      return res.status(404).json({ error: `No saved session named "${session}". Create it first via POST /sessions.` });
    }
  }

  const jobId = uuidv4();
  const dir = jobDirFor(jobId);
  jobs.set(jobId, { status: 'pending', log: [], createdAt: Date.now() });
  saveMeta(jobId);

  res.status(202).json({ jobId, status: 'pending' });

  const job = jobs.get(jobId);
  job.status = 'processing';
  saveMeta(jobId);

  const onLog = (line) => {
    job.log.push(`[${new Date().toISOString()}] ${line}`);
    saveMeta(jobId);
  };

  // Fires the moment an action fails - NOT after the (potentially slow)
  // ffmpeg conversion of the partial video finishes. This is the fix for
  // errors being reported late: the failure is now signaled as fast as the
  // render server signals its own failures, even though - unlike the
  // render server - a partial video may still show up moments later. No
  // output_url in this payload yet, so fireCallback won't delete the job -
  // it's still mid-encode.
  //
  // Status is "partial", not "error": an action failing partway through
  // still leaves real, watchable video up to that point (the finalize/
  // ffmpeg step always runs right after this fires) - that's meaningfully
  // different from a job that produced nothing at all, and a consumer
  // reacting to this webhook needs to be able to tell those two cases
  // apart rather than treating every action failure as a hard error.
  const onActionError = (message, failedAtIndex) => {
    job.status = 'partial';
    job.error = message;
    job.failedAtIndex = failedAtIndex;
    saveMeta(jobId);
    fireCallbackSafely(callbackUrl, { source: 'autobrowse', job_id: jobId, status: 'partial', error: message });
  };

  runRecordingJob({ actions, options, jobDir: dir, onLog, storageStatePath, onActionError })
    .then(({ outputPath, screenshots, actionError }) => {
      job.status = actionError ? 'partial' : 'done';
      job.outputPath = outputPath;
      job.screenshots = screenshots;
      if (actionError) job.error = actionError;
      saveMeta(jobId);

      const output_url = `${PUBLIC_BASE_URL}/recordings/${jobId}/output`;
      if (actionError) {
        // Follow-up to the instant partial notice above - same status, now
        // with the partial video actually ready to fetch. The job stays in
        // memory even after this delivers successfully, since output_url
        // is present - actual cleanup happens once /output is fetched.
        fireCallbackSafely(callbackUrl, { source: 'autobrowse', job_id: jobId, status: 'partial', error: actionError, output_url });
      } else {
        fireCallbackSafely(callbackUrl, { source: 'autobrowse', job_id: jobId, status: 'done', output_url });
      }
    })
    .catch((err) => {
      // A hard failure with no usable video at all (e.g. Chromium itself
      // never launched) - nothing to deliver, ever. This is the ONLY case
      // that still reports "error": every other failure mode above still
      // has a video, so it's reported as "partial" instead. Single
      // callback, no output_url, delete on success (nothing more is coming).
      job.status = 'error';
      job.error = err.message;
      onLog(`FATAL: ${err.message}`);
      saveMeta(jobId);
      fireCallbackSafely(callbackUrl, { source: 'autobrowse', job_id: jobId, status: 'error', error: err.message });
    });
});

// POST /inspect  { url: "...", steps?: [...], options?: {...}, session?: "name" }
// Synchronous (no job id, no polling) - navigates once, returns a pruned
// list of the page's actual interactive elements (links/buttons/inputs/
// images with alt text) so an action-planning step can generate selectors
// grounded in the real DOM instead of guessing. Meant to run as a step
// BEFORE building the actions array for POST /record, not during it -
// call this once per page (or page-to-page journey, via `steps`) you're
// about to plan for, feed the result to whatever generates your actions
// JSON, then call /record with the selectors it comes back with.
//
// `steps`, if given, is a chain of navigation-only actions (goto/click/
// scroll/waitForSelector/pressKey/search/zoomIn/zoomOut) walked in order
// AFTER the initial `url`, with a fresh element snapshot taken after each
// one - for grounding a click-through flow (e.g. "click Shop, then click a
// product") in every real page it actually reaches, not just the first.
app.post('/inspect', async (req, res) => {
  const { url, steps, options, session, maxElementsPerType } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Body must include a "url" string' });
  }

  const stepList = Array.isArray(steps) ? steps : [];
  if (stepList.length > 0) {
    const disallowed = stepList.some((s) => s && (s.type === 'screenshot' || (s.type === 'highlight' && s.captureScreenshot)));
    if (disallowed) {
      return res.status(400).json({
        error: '"steps" cannot include "screenshot" actions, or "highlight" actions with captureScreenshot - inspection has no job directory to save files into. Use POST /record for anything that needs to persist a file.',
      });
    }
    const stepErrors = validateActions(stepList);
    if (stepErrors.length > 0) {
      return res.status(400).json({ error: 'Invalid steps', details: stepErrors });
    }
  }

  let storageStatePath = null;
  if (session) {
    try {
      storageStatePath = sessionPathFor(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(storageStatePath)) {
      return res.status(404).json({ error: `No saved session named "${session}". Create it first via POST /sessions.` });
    }
  }

  try {
    const result = await inspectPage({ url, steps: stepList, options, storageStatePath, maxElementsPerType });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /recordings/:id -> status + log + output_url (once something is deliverable)
app.get('/recordings/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const body = { jobId: req.params.id, status: job.status, log: job.log, error: job.error };
  if (job.outputPath) {
    // A partial video is deliverable even on status "error" - it shows
    // exactly where the action list broke, rather than giving you nothing.
    body.output_url = `${PUBLIC_BASE_URL}/recordings/${req.params.id}/output`;
  }
  if (job.screenshots && job.screenshots.length) {
    body.screenshots = job.screenshots.map((name) => `${PUBLIC_BASE_URL}/recordings/${req.params.id}/screenshots/${name}`);
  }
  res.json(body);
});

// GET /recordings/:id/output -> serves the mp4, then cleans up (consume-on-delivery)
app.get('/recordings/:id/output', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!job.outputPath) {
    return res.status(409).json({ error: `job is not ready (status: ${job.status})` });
  }
  if (!fs.existsSync(job.outputPath)) {
    return res.status(410).json({ error: 'output no longer available (already delivered and cleaned up, or pruned)' });
  }

  res.sendFile(job.outputPath, (err) => {
    if (err) {
      console.error(`Failed to send output for job ${req.params.id}:`, err.message);
      return;
    }
    // Only clean up screenshots-less state after the video itself has gone
    // out - if screenshots exist and haven't been fetched yet, leave them
    // until the whole job directory is pruned or explicitly deleted.
    if (!job.screenshots || job.screenshots.length === 0) {
      cleanup(req.params.id);
    } else {
      job.outputPath = null; // mark video as delivered, keep dir for screenshot fetches
      saveMeta(req.params.id);
    }
  });
});

// GET /recordings/:id/screenshots/:filename -> serves a still PNG taken mid-job
app.get('/recordings/:id/screenshots/:filename', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const filePath = path.join(jobDirFor(req.params.id), req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'screenshot not found' });
  res.sendFile(filePath);
});

// POST /sessions  { name: "my-session", actions: [...login steps...] }
// Runs the given actions ONCE (e.g. a login form) and saves the resulting
// cookies/localStorage under that name. The actions themselves (which may
// contain a password in a `type` step) are used only in-memory for this
// request and are never written to disk, logged, or echoed back.
app.post('/sessions', async (req, res) => {
  const { name, actions, options } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Body must include a "name" string' });
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "actions" array' });
  }

  let storageStatePath;
  try {
    storageStatePath = sessionPathFor(name);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log = [];
  try {
    await createSession({ actions, options, storageStatePath, onLog: (line) => log.push(line) });
    res.json({ name, status: 'saved', log });
  } catch (err) {
    res.status(500).json({ error: err.message, log });
  }
});

// GET /sessions -> list saved session names only (never the cookie contents)
app.get('/sessions', (_req, res) => {
  const names = fs.existsSync(SESSIONS_ROOT)
    ? fs.readdirSync(SESSIONS_ROOT).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  res.json({ sessions: names });
});

// DELETE /sessions/:name -> revoke a saved session (e.g. after it expires or you log out elsewhere)
app.delete('/sessions/:name', (req, res) => {
  let storageStatePath;
  try {
    storageStatePath = sessionPathFor(req.params.name);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  fs.rm(storageStatePath, { force: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name: req.params.name, status: 'deleted' });
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Admin cleanup, matching the render server's /admin/prune_jobs shape.
function pruneStaleJobs(olderThanHours) {
  const cutoffMs = Date.now() - olderThanHours * 3600 * 1000;
  let prunedCount = 0;
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt < cutoffMs) {
      cleanup(jobId);
      prunedCount++;
    }
  }
  return { prunedCount, remainingCount: jobs.size, olderThanHours };
}

app.delete('/admin/prune_jobs', (req, res) => {
  const olderThanHours = Number(req.query.olderThanHours) || PRUNE_AFTER_HOURS;
  res.json(pruneStaleJobs(olderThanHours));
});

// Automatic internal prune, running hourly regardless of admin calls.
setInterval(() => {
  const result = pruneStaleJobs(PRUNE_AFTER_HOURS);
  if (result.prunedCount > 0) {
    console.log(`Auto-prune: removed ${result.prunedCount} job(s) older than ${PRUNE_AFTER_HOURS}h. ${result.remainingCount} remaining.`);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`AutoBrowse Recorder listening on port ${PORT}`);
});
