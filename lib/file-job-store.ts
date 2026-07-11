import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type FileJobStatus = "pending" | "running" | "completed" | "failed";

export type FileJobRecord = {
  id: string;
  status: FileJobStatus;
  leaseId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
};

const STATUS_DIRS: FileJobStatus[] = ["pending", "running", "completed", "failed"];

export async function putPendingFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
) {
  await ensureFileJobStore(rootDir, namespace);
  const existing = await findFileJob<T>(rootDir, namespace, job.id);
  if (existing) return existing.job;
  await writeJobFile(filePath(rootDir, namespace, "pending", job.id), job);
  return job;
}

export async function getFileJob<T extends FileJobRecord>(rootDir: string, namespace: string, jobId: string) {
  await ensureFileJobStore(rootDir, namespace);
  const found = await findFileJob<T>(rootDir, namespace, jobId);
  if (!found) throw new Error("File job not found");
  return found.job;
}

export async function claimNextFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  options: { order?: "oldest" | "newest"; runningTimeoutMs?: number } = {},
) {
  await ensureFileJobStore(rootDir, namespace);
  await recoverStaleFileJobs<T>(rootDir, namespace, options.runningTimeoutMs);
  await recoverStaleClaimLocks(rootDir, namespace);
  const pendingDir = stateDir(rootDir, namespace, "pending");
  const entries = (await readdir(pendingDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const candidates = await Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    job: await readJobFile<T>(path.join(pendingDir, entry.name)),
  })));
  const direction = options.order === "newest" ? -1 : 1;
  candidates.sort((left, right) => direction * (Date.parse(left.job.createdAt) - Date.parse(right.job.createdAt)));
  for (const candidate of candidates) {
    const pendingPath = path.join(pendingDir, candidate.name);
    const runningPath = path.join(stateDir(rootDir, namespace, "running"), candidate.name);
    const claimLockPath = path.join(rootDir, namespace, "claim-locks", candidate.name.replace(/\.json$/, ""));
    try {
      await mkdir(claimLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try {
        await rename(pendingPath, runningPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const now = new Date().toISOString();
      const claimed = {
        ...candidate.job,
        status: "running" as const,
        leaseId: randomUUID(),
        startedAt: now,
        updatedAt: now,
      } as T;
      await writeJobFile(runningPath, claimed);
      return claimed;
    } finally {
      await rm(claimLockPath, { recursive: true, force: true });
    }
  }
  return null;
}

export async function readRunningFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  jobId: string,
  leaseId: string,
) {
  const runningPath = filePath(rootDir, namespace, "running", jobId);
  const job = await readJobFile<T>(runningPath);
  if (!leaseId || job.leaseId !== leaseId) throw new Error("File job lease is stale or invalid");
  return { job, runningPath };
}

export async function finishRunningFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
  finalStatus: "completed" | "failed",
) {
  const runningPath = filePath(rootDir, namespace, "running", job.id);
  const finalPath = filePath(rootDir, namespace, finalStatus, job.id);
  const finalized = { ...job, status: finalStatus, updatedAt: new Date().toISOString() } as T;
  await writeJobFile(runningPath, finalized);
  await rename(runningPath, finalPath);
  return finalized;
}

export async function ensureFileJobStore(rootDir: string, namespace: string) {
  await Promise.all([
    ...STATUS_DIRS.map((status) => mkdir(stateDir(rootDir, namespace, status), { recursive: true })),
    mkdir(path.join(rootDir, namespace, "archive"), { recursive: true }),
    mkdir(path.join(rootDir, namespace, "results"), { recursive: true }),
    mkdir(path.join(rootDir, namespace, "claim-locks"), { recursive: true }),
  ]);
}

export function fileJobResultDir(rootDir: string, namespace: string) {
  return path.join(rootDir, namespace, "results");
}

async function recoverStaleFileJobs<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  runningTimeoutMs = 0,
) {
  if (!runningTimeoutMs) return;
  const runningDir = stateDir(rootDir, namespace, "running");
  const entries = (await readdir(runningDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  for (const entry of entries) {
    const runningPath = path.join(runningDir, entry.name);
    const job = await readJobFile<T>(runningPath);
    const startedAt = Date.parse(job.startedAt || job.updatedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < runningTimeoutMs) continue;
    const recovered = {
      ...job,
      status: "pending" as const,
      leaseId: null,
      updatedAt: new Date().toISOString(),
    } as T;
    await writeJobFile(runningPath, recovered);
    try {
      await rename(runningPath, path.join(stateDir(rootDir, namespace, "pending"), entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function recoverStaleClaimLocks(rootDir: string, namespace: string, staleMs = 60_000) {
  const lockDir = path.join(rootDir, namespace, "claim-locks");
  const entries = await readdir(lockDir, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const target = path.join(lockDir, entry.name);
    try {
      const info = await stat(target);
      if (Date.now() - info.mtimeMs > staleMs) await rm(target, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function findFileJob<T extends FileJobRecord>(rootDir: string, namespace: string, jobId: string) {
  for (const status of ["completed", "running", "pending", "failed"] as const) {
    try {
      return { status, job: await readJobFile<T>(filePath(rootDir, namespace, status, jobId)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

function stateDir(rootDir: string, namespace: string, status: FileJobStatus) {
  return path.join(rootDir, namespace, status);
}

function filePath(rootDir: string, namespace: string, status: FileJobStatus, jobId: string) {
  return path.join(stateDir(rootDir, namespace, status), `${path.basename(jobId)}.json`);
}

async function readJobFile<T>(target: string) {
  return JSON.parse(await readFile(target, "utf8")) as T;
}

async function writeJobFile(target: string, job: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
