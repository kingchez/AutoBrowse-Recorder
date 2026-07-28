const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { runRecordingJob, createSession } = require('./recorder');

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
  // Guard against path traversal via the session name.
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Invalid session name');
  return path.join(SESSIONS_ROOT, `${safe}.json`);
}

function jobDirFor(id) {
  return path.join(JOBS_ROOT, id);
}

// In-memory job registry: id -> { status, log, createdAt, outputPath?, screenshots?, error? }
// status is one of: "pending" | "processing" | "done" | "error"
// ("done"/"error" mirror the render server's terminology; "error" jobs can
// still have an outputPath if the recording got partway before failing.)
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
      status: meta.actionError ? 'error' : 'done',
      log: meta.log || [],
      createdAt: meta.createdAt || finishedAtMs,
      outputPath,
      screenshots: meta.screenshots || [],
      error: meta.actionError || undefined,
    });
  }
}
recoverJobsFromDisk();

// POST /record  { actions: [...], options?: { width, height }, session?: "name" }
// Returns immediately with a job id; recording happens async since it's wall-clock bound.
app.post('/record', (req, res) => {
  const { actions, options, session } = req.body || {};

  if (!Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "actions" array' });
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

  runRecordingJob({ actions, options, jobDir: dir, onLog, storageStatePath })
    .then(({ outputPath, screenshots, actionError }) => {
      job.status = actionError ? 'error' : 'done';
      job.outputPath = outputPath;
      job.screenshots = screenshots;
      if (actionError) job.error = actionError;
      saveMeta(jobId);
    })
    .catch((err) => {
      // A hard failure with no usable video at all (e.g. Chromium itself
      // never launched) - nothing to deliver, so clean up immediately.
      job.status = 'error';
      job.error = err.message;
      onLog(`FATAL: ${err.message}`);
      saveMeta(jobId);
    });
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
