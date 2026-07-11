import { copyFile, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_QUEUES = [
  ".tmp-season-pack-codex",
  ".tmp-video-prompt-pack-codex",
  ".tmp-batch-segment-repair-codex",
  ".tmp-video-prompt-codex",
  ".tmp-prompt-safety-codex",
  ".tmp-storyboard-codex",
  ".tmp-visual-asset-codex",
];

const ARCHIVABLE_STATUSES = new Set(["completed", "failed"]);

export async function archiveCodexTaskJobs(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const olderThanDays = Number.isFinite(options.olderThanDays) ? options.olderThanDays : 7;
  const now = options.now instanceof Date ? options.now : new Date();
  const queues = Array.isArray(options.queues) && options.queues.length ? options.queues : DEFAULT_QUEUES;
  const cutoffTime = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  const activeJobIds = await resolveActiveJobIds(rootDir, options);

  const summary = {
    rootDir,
    olderThanDays,
    archived: 0,
    scanned: 0,
    queues: [],
    protected: 0,
  };

  for (const queue of queues) {
    const queueSummary = await archiveQueueJobs(rootDir, queue, cutoffTime, activeJobIds);
    summary.archived += queueSummary.archived;
    summary.scanned += queueSummary.scanned;
    summary.protected += queueSummary.protected;
    summary.queues.push(queueSummary);
  }

  return summary;
}

async function archiveQueueJobs(rootDir, queue, cutoffTime, activeJobIds) {
  const queueRoot = join(rootDir, queue);
  const queueSummary = {
    queue,
    archived: 0,
    scanned: 0,
    protected: 0,
    skipped: 0,
  };
  const sources = [
    { status: null, sourceDir: join(queueRoot, "jobs"), archiveDir: join(queueRoot, "archive", "jobs") },
    { status: "completed", sourceDir: join(queueRoot, "completed"), archiveDir: join(queueRoot, "archive", "completed") },
    { status: "failed", sourceDir: join(queueRoot, "failed"), archiveDir: join(queueRoot, "archive", "failed") },
  ];
  for (const source of sources) {
    if (!existsSync(source.sourceDir)) {
      queueSummary.skipped += 1;
      continue;
    }
    const entries = await readdir(source.sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      queueSummary.scanned += 1;

      const sourcePath = join(source.sourceDir, entry.name);
      const job = await readJsonFile(sourcePath);
      const jobId = typeof job?.id === "string" ? job.id : entry.name.replace(/\.json$/i, "");
      if (activeJobIds.has(jobId)) {
        queueSummary.protected += 1;
        continue;
      }
      if (!shouldArchiveJob(job, cutoffTime, source.status)) continue;

      await mkdir(source.archiveDir, { recursive: true });
      await moveFile(sourcePath, join(source.archiveDir, entry.name));
      queueSummary.archived += 1;
    }
  }

  return queueSummary;
}

async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function shouldArchiveJob(job, cutoffTime, expectedStatus = null) {
  if (!job || !ARCHIVABLE_STATUSES.has(job.status)) return false;
  if (expectedStatus && job.status !== expectedStatus) return false;
  const timestamp = Date.parse(job.completedAt || job.failedAt || job.updatedAt || job.createdAt || "");
  return Number.isFinite(timestamp) && timestamp < cutoffTime;
}

async function moveFile(sourcePath, targetPath) {
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(sourcePath, targetPath);
    await unlink(sourcePath);
  }
}

function parseCliArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--days=")) options.olderThanDays = Number(arg.slice("--days=".length));
    if (arg.startsWith("--root=")) options.rootDir = arg.slice("--root=".length);
    if (arg.startsWith("--active-job-ids=")) options.activeJobIdsFile = arg.slice("--active-job-ids=".length);
  }
  return options;
}

async function resolveActiveJobIds(rootDir, options) {
  const direct = options.activeJobIds instanceof Set
    ? [...options.activeJobIds]
    : Array.isArray(options.activeJobIds) ? options.activeJobIds : [];
  let fromFile = [];
  if (options.activeJobIdsFile) {
    const parsed = await readJsonFile(resolve(options.activeJobIdsFile));
    fromFile = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.activeJobIds) ? parsed.activeJobIds : [];
  }
  const fromBatchCache = options.readBatchCacheActiveJobIds === false
    ? []
    : await readActiveJobIdsFromBatchCache(rootDir);
  return new Set(
    [...direct, ...fromFile, ...fromBatchCache]
      .filter((value) => typeof value === "string" && value.trim())
      .map(String),
  );
}

async function readActiveJobIdsFromBatchCache(rootDir) {
  const cacheDir = join(rootDir, ".tmp-segment-batch-cache");
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const ids = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const cache = await readJsonFile(join(cacheDir, entry.name));
    if (!cache || typeof cache !== "object") continue;
    if (Array.isArray(cache.activeJobIds)) ids.push(...cache.activeJobIds);
    for (const state of Array.isArray(cache.segmentStates) ? cache.segmentStates : []) {
      if (!state || typeof state !== "object") continue;
      for (const key of ["activeRepairJobId", "activeRenderPackJobId", "activeJudgeJobId"]) {
        if (typeof state[key] === "string") ids.push(state[key]);
      }
    }
  }
  return ids;
}

async function main() {
  const summary = await archiveCodexTaskJobs(parseCliArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
