import { copyFile, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_QUEUES = [
  ".tmp-season-pack-codex",
  ".tmp-video-prompt-pack-codex",
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

  const summary = {
    rootDir,
    olderThanDays,
    archived: 0,
    scanned: 0,
    queues: [],
  };

  for (const queue of queues) {
    const queueSummary = await archiveQueueJobs(rootDir, queue, cutoffTime);
    summary.archived += queueSummary.archived;
    summary.scanned += queueSummary.scanned;
    summary.queues.push(queueSummary);
  }

  return summary;
}

async function archiveQueueJobs(rootDir, queue, cutoffTime) {
  const jobsDir = join(rootDir, queue, "jobs");
  const archiveDir = join(rootDir, queue, "archive", "jobs");
  const queueSummary = {
    queue,
    jobsDir,
    archiveDir,
    archived: 0,
    scanned: 0,
    skipped: existsSync(jobsDir) ? 0 : 1,
  };

  if (!existsSync(jobsDir)) return queueSummary;

  const entries = await readdir(jobsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    queueSummary.scanned += 1;

    const sourcePath = join(jobsDir, entry.name);
    const job = await readJsonFile(sourcePath);
    if (!shouldArchiveJob(job, cutoffTime)) continue;

    await mkdir(archiveDir, { recursive: true });
    await moveFile(sourcePath, join(archiveDir, entry.name));
    queueSummary.archived += 1;
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

function shouldArchiveJob(job, cutoffTime) {
  if (!job || !ARCHIVABLE_STATUSES.has(job.status)) return false;
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
  }
  return options;
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
