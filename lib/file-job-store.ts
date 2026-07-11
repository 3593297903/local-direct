import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export type FileJobStatus = "pending" | "running" | "completed" | "failed";

export type FileJobRecord = {
  id: string;
  status: FileJobStatus;
  leaseId: string | null;
  workerId?: string | null;
  heartbeatAt?: string;
  attempt?: number;
  fencingToken?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
};

export type AtomicReplaceJsonOptions = {
  rootDir: string;
  retryDelaysMs?: readonly number[];
  renameImpl?: (source: string, destination: string) => Promise<void>;
};

const STATUS_DIRS: FileJobStatus[] = ["pending", "running", "completed", "failed"];
const WINDOWS_RENAME_RETRY_DELAYS_MS = [0, 25, 75, 200, 500] as const;
const TRANSIENT_WINDOWS_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export class FileJobStorageError extends Error {
  readonly code = "JOB_STORAGE_BUSY";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileJobStorageError";
  }
}

export class FileJobLeaseError extends Error {
  readonly code = "JOB_LEASE_LOST";

  constructor(message = "File job lease is stale or invalid") {
    super(message);
    this.name = "FileJobLeaseError";
  }
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function assertPathInsideRoot(rootDir: string, target: string) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`File job target is outside the configured queue root: ${resolved}`);
  }
  return resolved;
}

function isTransientWindowsFileError(error: unknown) {
  return TRANSIENT_WINDOWS_FILE_CODES.has((error as NodeJS.ErrnoException | undefined)?.code || "");
}

async function renameWithRetry(
  source: string,
  destination: string,
  retryDelaysMs: readonly number[] = WINDOWS_RENAME_RETRY_DELAYS_MS,
  renameImpl: (source: string, destination: string) => Promise<void> = rename,
) {
  let finalError: unknown;
  const attempts = retryDelaysMs.length ? retryDelaysMs : [0];
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index] > 0) {
      const jitterMs = Math.floor(Math.random() * Math.max(1, Math.min(25, Math.ceil(attempts[index] / 4))));
      await wait(attempts[index] + jitterMs);
    }
    try {
      await renameImpl(source, destination);
      return;
    } catch (error) {
      finalError = error;
      if (!isTransientWindowsFileError(error)) throw error;
      if (index === attempts.length - 1) {
        throw new FileJobStorageError("Queue storage is temporarily busy", { cause: error });
      }
    }
  }
  throw finalError;
}

async function syncParentDirectory(target: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.dirname(target), "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "EPERM" && code !== "EACCES") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicReplaceJson(
  target: string,
  value: unknown,
  options: AtomicReplaceJsonOptions,
) {
  const resolvedTarget = assertPathInsideRoot(options.rootDir, target);
  await mkdir(path.dirname(resolvedTarget), { recursive: true });
  const temporary = `${resolvedTarget}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameWithRetry(
      temporary,
      resolvedTarget,
      options.retryDelaysMs,
      options.renameImpl,
    );
    await syncParentDirectory(resolvedTarget);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicMoveFile(
  source: string,
  destination: string,
  options: { rootDir: string; retryDelaysMs?: readonly number[] },
) {
  const resolvedSource = assertPathInsideRoot(options.rootDir, source);
  const resolvedDestination = assertPathInsideRoot(options.rootDir, destination);
  await mkdir(path.dirname(resolvedDestination), { recursive: true });
  await renameWithRetry(resolvedSource, resolvedDestination, options.retryDelaysMs);
  await syncParentDirectory(resolvedDestination);
}

export async function putPendingFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
) {
  await ensureFileJobStore(rootDir, namespace);
  const createLockPath = path.join(rootDir, namespace, "create-locks", path.basename(job.id));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(createLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await findFileJob<T>(rootDir, namespace, job.id);
      if (existing) return existing.job;
      await recoverStaleDirectoryLock(createLockPath);
      await wait(25);
      continue;
    }

    try {
      const existing = await findFileJob<T>(rootDir, namespace, job.id);
      if (existing) return existing.job;
      await writeJobFile(rootDir, filePath(rootDir, namespace, "pending", job.id), job);
      return job;
    } finally {
      await rm(createLockPath, { recursive: true, force: true });
    }
  }
  throw new FileJobStorageError("Timed out waiting for the idempotent file job create lock");
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
  options: {
    order?: "oldest" | "newest";
    runningTimeoutMs?: number;
    workerId?: string;
    canRecoverRunningJob?: (job: T) => boolean | Promise<boolean>;
  } = {},
) {
  await ensureFileJobStore(rootDir, namespace);
  await recoverStaleFileJobs<T>(
    rootDir,
    namespace,
    options.runningTimeoutMs,
    options.canRecoverRunningJob,
  );
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
        await renameWithRetry(pendingPath, runningPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const now = new Date().toISOString();
      const claimed = {
        ...candidate.job,
        status: "running" as const,
        leaseId: randomUUID(),
        workerId: options.workerId || `worker-${process.pid}`,
        heartbeatAt: now,
        attempt: Math.max(0, Number(candidate.job.attempt) || 0) + 1,
        fencingToken: Math.max(0, Number(candidate.job.fencingToken) || 0) + 1,
        startedAt: now,
        updatedAt: now,
      } as T;
      await writeJobFile(rootDir, runningPath, claimed);
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
  fencingToken?: number,
) {
  const runningPath = filePath(rootDir, namespace, "running", jobId);
  const job = await readJobFile<T>(runningPath);
  if (!leaseId || job.leaseId !== leaseId) throw new Error("File job lease is stale or invalid");
  if (fencingToken !== undefined && job.fencingToken !== fencingToken) {
    throw new Error("File job fencing token is stale or invalid");
  }
  return { job, runningPath };
}

export async function finishRunningFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
  finalStatus: "completed" | "failed",
) {
  return finishActiveFileJob(rootDir, namespace, job, "running", finalStatus);
}

export async function finishPendingFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
  finalStatus: "completed" | "failed",
) {
  return finishActiveFileJob(rootDir, namespace, job, "pending", finalStatus);
}

async function finishActiveFileJob<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  job: T,
  activeStatus: "pending" | "running",
  finalStatus: "completed" | "failed",
) {
  const activePath = filePath(rootDir, namespace, activeStatus, job.id);
  const finalPath = filePath(rootDir, namespace, finalStatus, job.id);
  const release = await acquireJobStateLock(rootDir, namespace, job.id);
  try {
    let current: T;
    try {
      current = await readJobFile<T>(activePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileJobLeaseError();
      throw error;
    }
    const leaseMatches = activeStatus === "pending"
      ? current.leaseId === null && job.leaseId === null
      : Boolean(job.leaseId) && current.leaseId === job.leaseId;
    if (!leaseMatches || Number(current.fencingToken || 0) !== Number(job.fencingToken || 0)) {
      throw new FileJobLeaseError();
    }
    const finalized = {
      ...current,
      ...job,
      status: finalStatus,
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as T;
    await writeJobFile(rootDir, activePath, finalized);
    await renameWithRetry(activePath, finalPath);
    return finalized;
  } finally {
    await release();
  }
}

export async function ensureFileJobStore(rootDir: string, namespace: string) {
  await Promise.all([
    ...STATUS_DIRS.map((status) => mkdir(stateDir(rootDir, namespace, status), { recursive: true })),
    mkdir(path.join(rootDir, namespace, "archive"), { recursive: true }),
    mkdir(path.join(rootDir, namespace, "results"), { recursive: true }),
    mkdir(path.join(rootDir, namespace, "claim-locks"), { recursive: true }),
    mkdir(path.join(rootDir, namespace, "create-locks"), { recursive: true }),
  ]);
}

export function fileJobResultDir(rootDir: string, namespace: string) {
  return path.join(rootDir, namespace, "results");
}

async function recoverStaleFileJobs<T extends FileJobRecord>(
  rootDir: string,
  namespace: string,
  runningTimeoutMs = 0,
  canRecoverRunningJob?: (job: T) => boolean | Promise<boolean>,
) {
  if (!runningTimeoutMs) return;
  const runningDir = stateDir(rootDir, namespace, "running");
  const entries = (await readdir(runningDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  for (const entry of entries) {
    const runningPath = path.join(runningDir, entry.name);
    const release = await acquireJobStateLock(rootDir, namespace, entry.name.replace(/\.json$/, ""));
    try {
      let job: T;
      try {
        job = await readJobFile<T>(runningPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (job.status === "completed" || job.status === "failed") {
        await renameWithRetry(runningPath, path.join(stateDir(rootDir, namespace, job.status), entry.name));
        continue;
      }
      const heartbeatAt = Date.parse(job.heartbeatAt || job.startedAt || job.updatedAt);
      if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt < runningTimeoutMs) continue;
      if (canRecoverRunningJob && !(await canRecoverRunningJob(job))) continue;
      const recovered = {
        ...job,
        status: "pending" as const,
        leaseId: null,
        workerId: null,
        heartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as T;
      await writeJobFile(rootDir, runningPath, recovered);
      await renameWithRetry(runningPath, path.join(stateDir(rootDir, namespace, "pending"), entry.name));
    } finally {
      await release();
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

async function recoverStaleDirectoryLock(target: string, staleMs = 60_000) {
  try {
    const info = await stat(target);
    if (Date.now() - info.mtimeMs > staleMs) await rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireJobStateLock(rootDir: string, namespace: string, jobId: string) {
  const lockPath = path.join(rootDir, namespace, "claim-locks", path.basename(jobId));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverStaleDirectoryLock(lockPath);
      await wait(25);
    }
  }
  throw new FileJobStorageError("Timed out waiting for the file job state lock");
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

async function writeJobFile(rootDir: string, target: string, job: unknown) {
  await atomicReplaceJson(target, job, { rootDir });
}
