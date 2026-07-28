const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { runRecordingJob } = require('./recorder');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const JOBS_ROOT = process.env.JOBS_DIR || path.join(__dirname, '..', 'data', 'jobs');
const PRUNE_AFTER_HOURS = Number(process.env.PRUNE_AFTER_HOURS || 48);

fs.mkdirSync(JOBS_ROOT, { recursive: true });

// In-memory job registry. Rebuilt from disk on boot so restarts don't lose track
// of jobs that already finished (mirrors the render server's mtime-based recovery).
const jobs = new Map();

function jobDirFor(id) {
  return path.join(JOBS_ROOT, id);
}

function loadExistingJobsFromDisk() {
  if (!fs.existsSync(JOBS_ROOT)) return;
  for (const id of fs.readdirSync(JOBS_ROOT)) {
    const dir = jobDirFor(id);
    const mp4 = path.join(dir, 'output.mp4');
    const metaPath = path.join(dir, 'meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { /* ignore corrupt meta */ }
    }
    if (fs.existsSync(mp4)) {
      const stat = fs.statSync(mp4);
      jobs.set(id, { status: 'completed', log: meta.log || [], createdAt: meta.createdAt || stat.mtime.toISOString() });
    } else if (fs.existsSync(dir)) {
      // Directory exists but no output.mp4 -> the process died mid-job. Mark failed rather than
      // silently hanging forever.
      jobs.set(id, { status: 'failed', log: meta.log || ['Job interrupted by server restart'], createdAt: meta.createdAt || new Date().toISOString() });
    }
  }
}
loadExistingJobsFromDisk();

function saveMeta(id) {
  const job = jobs.get(id);
  if (!job) return;
  const dir = jobDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(job, null, 2));
}

// POST /record  { actions: [...], options?: { width, height } }
// Returns immediately with a job id; recording happens async since it's wall-clock bound.
app.post('/record', (req, res) => {
  const { actions, options } = req.body || {};

  if (!Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "actions" array' });
  }

  const id = uuidv4();
  const dir = jobDirFor(id);
  const job = { status: 'processing', log: [], createdAt: new Date().toISOString() };
  jobs.set(id, job);
  saveMeta(id);

  const onLog = (line) => {
    job.log.push(`[${new Date().toISOString()}] ${line}`);
    saveMeta(id);
  };

  runRecordingJob({ actions, options, jobDir: dir, onLog })
    .then(() => {
      job.status = 'completed';
      saveMeta(id);
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      onLog(`ERROR: ${err.message}`);
      saveMeta(id);
    });

  res.status(202).json({ id, status: job.status });
});

// GET /recordings/:id -> job status + log
app.get('/recordings/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: req.params.id, status: job.status, log: job.log, error: job.error });
});

// GET /recordings/:id/output -> streams the mp4, deletes it after successful delivery
app.get('/recordings/:id/output', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') {
    return res.status(409).json({ error: `Job is ${job.status}, not ready for delivery` });
  }

  const mp4Path = path.join(jobDirFor(id), 'output.mp4');
  if (!fs.existsSync(mp4Path)) {
    return res.status(410).json({ error: 'Output already delivered or pruned' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  const stream = fs.createReadStream(mp4Path);
  stream.pipe(res);
  stream.on('close', () => {
    // Consume-on-delivery, same as the render server, to avoid disk buildup.
    fs.rm(jobDirFor(id), { recursive: true, force: true }, () => {});
    jobs.delete(id);
  });
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Prune undelivered jobs older than PRUNE_AFTER_HOURS, checked hourly.
setInterval(() => {
  const cutoff = Date.now() - PRUNE_AFTER_HOURS * 3600 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) {
      fs.rm(jobDirFor(id), { recursive: true, force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`AutoBrowse Recorder listening on port ${PORT}`);
});
