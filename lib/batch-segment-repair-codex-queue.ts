import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertCleanCodexPromptInput,
  compileCodexPromptText,
} from "./codex-prompt-input-compiler";
import {
  isAllowedBatchSegmentRepairPath,
  validateBatchSegmentRepairPatchResult,
  type BatchSegmentRepairOperation,
  type BatchSegmentRepairPatchResult,
} from "./batch-segment-repair-patch";
import { atomicMoveFile, atomicReplaceJson } from "./file-job-store";
import { readCodexRuntimeHealth } from "./codex-runtime-health";

export type BatchSegmentRepairCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type BatchSegmentRepairFindingInput = {
  code: string;
  message: string;
  path?: string;
  slotId?: string;
};

export type { BatchSegmentRepairOperation, BatchSegmentRepairPatchResult } from "./batch-segment-repair-patch";

export type CreateBatchSegmentRepairCodexJobInput = {
  projectId?: string;
  batchId: string;
  segmentIndex: number;
  slotId?: string;
  contractHash: string;
  resultHash: string;
  sourceTextForModel: string;
  allowedPaths: string[];
  currentValues: Record<string, string>;
  findings: BatchSegmentRepairFindingInput[];
  forbiddenFutureEvents?: string[];
};

export type BatchSegmentRepairCodexJob = {
  id: string;
  idempotencyKey: string;
  projectId: string | null;
  batchId: string;
  segmentIndex: number;
  slotId: string | null;
  contractHash: string;
  resultHash: string;
  sourceTextForModel: string;
  allowedPaths: string[];
  currentValues: Record<string, string>;
  findings: BatchSegmentRepairFindingInput[];
  forbiddenFutureEvents: string[];
  prompt: string;
  outputPath: string;
  status: BatchSegmentRepairCodexJobStatus;
  leaseId: string | null;
  workerId: string | null;
  heartbeatAt?: string;
  attempt: number;
  fencingToken: number;
  result: BatchSegmentRepairPatchResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

type QueueOptions = { rootDir?: string };
type ClaimOptions = QueueOptions & { order?: "oldest" | "newest"; runningTimeoutMs?: number; workerId?: string };

const TASK_ROOT = ".tmp-batch-segment-repair-codex";
const RESULT_DIR = "results";
const CLAIM_LOCK_DIR = "claim-locks";
const CREATE_LOCK_DIR = "create-locks";
const STATE_DIRS: Record<BatchSegmentRepairCodexJobStatus, string> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
};
export class BatchSegmentRepairCodexQueueError extends Error {
  readonly code: string;

  constructor(message: string, code = "REPAIR_JOB_INVALID") {
    super(message);
    this.name = "BatchSegmentRepairCodexQueueError";
    this.code = code;
  }
}

export async function createBatchSegmentRepairCodexJob(
  input: CreateBatchSegmentRepairCodexJobInput,
  options: QueueOptions = {},
) {
  const normalized = validateCreateInput(input);
  const rootDir = resolveRootDir(options);
  await ensureQueueDirs(rootDir);
  const now = new Date().toISOString();
  const idempotencyKey = buildRepairIdempotencyKey(normalized);
  const id = `batch-segment-repair-job-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
  const createLockPath = path.join(rootDir, TASK_ROOT, CREATE_LOCK_DIR, id);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(createLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await locateJob(rootDir, id);
      if (existing) return existing.job;
      await recoverStaleDirectoryLock(createLockPath);
      await wait(25);
      continue;
    }

    try {
      const existing = await locateJob(rootDir, id);
      if (existing) return existing.job;
      const outputPath = path.join(rootDir, TASK_ROOT, RESULT_DIR, `${id}.json`);
      const prompt = buildRepairPrompt(normalized, outputPath);
      assertCleanCodexPromptInput(prompt, "Batch segment repair Codex prompt");
      const job: BatchSegmentRepairCodexJob = {
        id,
        idempotencyKey,
        projectId: normalized.projectId || null,
        batchId: normalized.batchId,
        segmentIndex: normalized.segmentIndex,
        slotId: normalized.slotId || null,
        contractHash: normalized.contractHash,
        resultHash: normalized.resultHash,
        sourceTextForModel: normalized.sourceTextForModel,
        allowedPaths: normalized.allowedPaths,
        currentValues: normalized.currentValues,
        findings: normalized.findings,
        forbiddenFutureEvents: normalized.forbiddenFutureEvents,
        prompt,
        outputPath,
        status: "pending",
        leaseId: null,
        workerId: null,
        attempt: 0,
        fencingToken: 0,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeJobAt(rootDir, jobPath(rootDir, "pending", id), job);
      return job;
    } finally {
      await rm(createLockPath, { recursive: true, force: true });
    }
  }
  throw new BatchSegmentRepairCodexQueueError(
    "Timed out waiting for the idempotent repair job create lock",
    "JOB_STORAGE_BUSY",
  );
}

function buildRepairIdempotencyKey(input: ReturnType<typeof validateCreateInput>) {
  const target = input.slotId || createHash("sha256")
    .update(JSON.stringify({ allowedPaths: input.allowedPaths, findings: input.findings }))
    .digest("hex")
    .slice(0, 20);
  return `patch:${input.batchId}:${input.segmentIndex}:${target}:${input.contractHash}`;
}

export async function getBatchSegmentRepairCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  await ensureQueueDirs(rootDir);
  const located = await locateJob(rootDir, jobId);
  if (!located) throw new BatchSegmentRepairCodexQueueError("Batch segment repair job not found", "JOB_NOT_FOUND");
  return syncLateRepairResult(rootDir, jobId);
}

export async function claimNextBatchSegmentRepairCodexJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  await ensureQueueDirs(rootDir);
  await recoverStaleRunningJobs(rootDir, options.runningTimeoutMs);
  await recoverStaleRepairClaimLocks(rootDir);
  const entries = await readdir(stateDir(rootDir, "pending"), { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => ({
        entry,
        job: await readJobAt(path.join(stateDir(rootDir, "pending"), entry.name)),
      })),
  );
  const direction = options.order === "newest" ? -1 : 1;
  candidates.sort((left, right) => direction * (Date.parse(left.job.createdAt) - Date.parse(right.job.createdAt)));

  for (const candidate of candidates) {
    const sourcePath = path.join(stateDir(rootDir, "pending"), candidate.entry.name);
    const runningPath = path.join(stateDir(rootDir, "running"), candidate.entry.name);
    const claimLockPath = path.join(rootDir, TASK_ROOT, CLAIM_LOCK_DIR, candidate.entry.name.replace(/\.json$/, ""));
    try {
      await mkdir(claimLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try {
        await atomicMoveFile(sourcePath, runningPath, { rootDir });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const now = new Date().toISOString();
      const claimed: BatchSegmentRepairCodexJob = {
        ...candidate.job,
        status: "running",
        leaseId: randomUUID(),
        workerId: options.workerId || `repair-worker-${process.pid}`,
        heartbeatAt: now,
        attempt: Math.max(0, Number(candidate.job.attempt) || 0) + 1,
        fencingToken: Math.max(0, Number(candidate.job.fencingToken) || 0) + 1,
        startedAt: now,
        updatedAt: now,
        error: null,
      };
      await writeJobAt(rootDir, runningPath, claimed);
      return claimed;
    } finally {
      await rm(claimLockPath, { recursive: true, force: true });
    }
  }
  return null;
}

export async function completeBatchSegmentRepairCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return syncLateRepairResult(rootDir, jobId, { leaseId, fencingToken });
}

export async function failBatchSegmentRepairCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withRepairJobStateLock(rootDir, jobId, async () => {
    const located = await locateJob(rootDir, jobId);
    if (!located) throw new BatchSegmentRepairCodexQueueError("Batch segment repair job not found", "JOB_NOT_FOUND");
    const job = located.job;
    assertLease(job, leaseId, fencingToken);
    if (located.status === "failed") return job;
    if (located.status !== "running") {
      throw new BatchSegmentRepairCodexQueueError("Completed repair job cannot be failed", "JOB_ALREADY_COMPLETED");
    }
    const now = new Date().toISOString();
    const failed: BatchSegmentRepairCodexJob = {
      ...job,
      status: "failed",
      error: message || "Batch segment repairs-only Codex job failed",
      heartbeatAt: now,
      updatedAt: now,
    };
    await writeJobAt(rootDir, located.filePath, failed);
    await atomicMoveFile(located.filePath, jobPath(rootDir, "failed", jobId), { rootDir });
    return failed;
  });
}

function validateCreateInput(input: CreateBatchSegmentRepairCodexJobInput) {
  const batchId = cleanRequiredString(input.batchId, "batchId", 200);
  const segmentIndex = Number(input.segmentIndex);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 1 || segmentIndex > 30) {
    throw new BatchSegmentRepairCodexQueueError("segmentIndex must be between 1 and 30");
  }
  const contractHash = cleanRequiredString(input.contractHash, "contractHash", 200);
  const resultHash = cleanRequiredString(input.resultHash, "resultHash", 200);
  const sourceTextForModel = cleanRequiredString(input.sourceTextForModel, "sourceTextForModel", 20_000);
  const allowedPaths = Array.from(new Set((input.allowedPaths || []).map(normalizeRepairPath).filter(Boolean)));
  if (!allowedPaths.length || allowedPaths.length > 16 || allowedPaths.some((item) => !isAllowedBatchSegmentRepairPath(item))) {
    throw new BatchSegmentRepairCodexQueueError("Repair job contains an unauthorized path");
  }
  const currentValues = Object.fromEntries(
    Object.entries(input.currentValues || {})
      .map(([key, value]) => [normalizeRepairPath(key), String(value || "")])
      .filter(([key]) => allowedPaths.includes(key)),
  );
  const findings = (input.findings || []).slice(0, 16).map((finding) => ({
    code: cleanRequiredString(finding.code, "finding.code", 120),
    message: cleanRequiredString(finding.message, "finding.message", 1_000),
    path: finding.path ? normalizeRepairPath(finding.path) : undefined,
    slotId: finding.slotId ? cleanRequiredString(finding.slotId, "finding.slotId", 200) : undefined,
  }));
  if (!findings.length) throw new BatchSegmentRepairCodexQueueError("Repair job is missing findings");
  return {
    ...input,
    batchId,
    segmentIndex,
    contractHash,
    resultHash,
    sourceTextForModel,
    allowedPaths,
    currentValues,
    findings,
    forbiddenFutureEvents: (input.forbiddenFutureEvents || []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20),
  };
}

function buildRepairPrompt(input: ReturnType<typeof validateCreateInput>, outputPath: string) {
  const payload = {
    batchId: input.batchId,
    segmentIndex: input.segmentIndex,
    slotId: input.slotId || null,
    contractHash: input.contractHash,
    resultHash: input.resultHash,
    findings: input.findings,
    allowedPaths: input.allowedPaths,
    currentValues: input.currentValues,
    sourceTextForModel: input.sourceTextForModel,
    forbiddenFutureEvents: input.forbiddenFutureEvents,
  };
  return [
    "You are handling a Local Director repairs-only field patch task.",
    "Return no complete video prompt result, storyboard array, workflow object, commentary, or markdown.",
    "Write one strict JSON object with exactly schemaVersion, contractHash, resultHash, and repairs.",
    "Each repair must contain path, replacement, reasonCode, and optional slotId.",
    "Only use a path listed in allowedPaths. Keep every unlisted field unchanged.",
    "replacement must be natural Chinese user-facing content, not a repair note or field explanation.",
    "reasonCode must be missing_event, continuity_contradiction, or quality_field.",
    "Do not reveal forbidden future events.",
    "Write UTF-8 JSON to the exact output path with Node.js fs.writeFileSync and JSON.stringify.",
    "Reply with exactly: DONE",
    "",
    compileCodexPromptText(JSON.stringify(payload, null, 2), { phase: "repair" }),
    `Output path: ${outputPath}`,
  ].join("\n");
}

async function readAndValidateRepairResult(job: BatchSegmentRepairCodexJob) {
  let parsed: unknown;
  try {
    const raw = stripJsonBom(await readFile(job.outputPath, "utf8"));
    parsed = JSON.parse(raw);
  } catch {
    throw new BatchSegmentRepairCodexQueueError("Codex did not produce valid repairs-only JSON");
  }
  try {
    return validateBatchSegmentRepairPatchResult(parsed, {
      contractHash: job.contractHash,
      resultHash: job.resultHash,
      allowedPaths: job.allowedPaths,
      allowedSlotIds: job.findings.map((finding) => finding.slotId || "").filter(Boolean),
      currentValues: job.currentValues,
    });
  } catch (error) {
    throw new BatchSegmentRepairCodexQueueError(error instanceof Error ? error.message : "Invalid repairs-only result");
  }
}

async function locateJob(rootDir: string, jobId: string) {
  for (const status of ["completed", "running", "pending", "failed"] as const) {
    const filePath = jobPath(rootDir, status, jobId);
    try {
      return { status, filePath, job: await readJobAt(filePath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function syncLateRepairResult(
  rootDir: string,
  jobId: string,
  expectedLease?: { leaseId: string; fencingToken: number },
) {
  return withRepairJobStateLock(rootDir, jobId, async () => {
    const located = await locateJob(rootDir, jobId);
    if (!located) throw new BatchSegmentRepairCodexQueueError("Batch segment repair job not found", "JOB_NOT_FOUND");
    const job = located.job;
    if (expectedLease) assertLease(job, expectedLease.leaseId, expectedLease.fencingToken);
    if (located.status === "completed") return job;
    if (located.status === "failed") {
      if (expectedLease) {
        throw new BatchSegmentRepairCodexQueueError("Failed repair job cannot be completed", "JOB_ALREADY_FAILED");
      }
      return job;
    }
    if (expectedLease && located.status !== "running") {
      throw new BatchSegmentRepairCodexQueueError("Repair job lease is stale or invalid", "JOB_LEASE_LOST");
    }
    let result: BatchSegmentRepairCodexJob["result"];
    try {
      result = await readAndValidateRepairResult(job);
    } catch (error) {
      if (expectedLease) throw error;
      return job;
    }
    const now = new Date().toISOString();
    const completed: BatchSegmentRepairCodexJob = {
      ...job,
      status: "completed",
      result,
      error: null,
      heartbeatAt: now,
      completedAt: job.completedAt || now,
      updatedAt: now,
    };
    await writeJobAt(rootDir, located.filePath, completed);
    await atomicMoveFile(located.filePath, jobPath(rootDir, "completed", completed.id), { rootDir });
    return completed;
  });
}

async function recoverStaleRunningJobs(rootDir: string, runningTimeoutMs = 0) {
  if (!runningTimeoutMs) return;
  const runtime = await readCodexRuntimeHealth("batch-segment-repair", {
    rootDir,
    maxAgeMs: Math.min(Math.max(30_000, Math.floor(runningTimeoutMs / 4)), 90_000),
  });
  if (runtime.status === "healthy") return;
  const entries = await readdir(stateDir(rootDir, "running"), { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const jobId = entry.name.replace(/\.json$/, "");
    await withRepairJobStateLock(rootDir, jobId, async () => {
      const runningPath = path.join(stateDir(rootDir, "running"), entry.name);
      let job: BatchSegmentRepairCodexJob;
      try {
        job = await readJobAt(runningPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const startedAt = Date.parse(job.heartbeatAt || job.startedAt || job.updatedAt);
      if (!Number.isFinite(startedAt) || Date.now() - startedAt < runningTimeoutMs) return;
      try {
        const outputStat = await stat(job.outputPath);
        const recentWindowMs = Math.min(Math.max(30_000, Math.floor(runningTimeoutMs / 3)), 5 * 60_000);
        if (Date.now() - outputStat.mtimeMs < recentWindowMs) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const recovered: BatchSegmentRepairCodexJob = {
        ...job,
        status: "pending",
        leaseId: null,
        workerId: null,
        heartbeatAt: new Date().toISOString(),
        error: "Repair task returned to pending after lease timeout",
        updatedAt: new Date().toISOString(),
      };
      await writeJobAt(rootDir, runningPath, recovered);
      await atomicMoveFile(runningPath, path.join(stateDir(rootDir, "pending"), entry.name), { rootDir });
    });
  }
}

async function recoverStaleRepairClaimLocks(rootDir: string, staleMs = 60_000) {
  const lockDir = path.join(rootDir, TASK_ROOT, CLAIM_LOCK_DIR);
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

function assertLease(job: BatchSegmentRepairCodexJob, leaseId: string, fencingToken: number) {
  if (!leaseId || job.leaseId !== leaseId) {
    throw new BatchSegmentRepairCodexQueueError("Repair job lease is stale or invalid", "JOB_LEASE_LOST");
  }
  if (!Number.isInteger(fencingToken) || job.fencingToken !== fencingToken) {
    throw new BatchSegmentRepairCodexQueueError("Repair job fencing token is stale or invalid", "JOB_LEASE_LOST");
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

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withRepairJobStateLock<T>(rootDir: string, jobId: string, callback: () => Promise<T>) {
  const lockPath = path.join(rootDir, TASK_ROOT, CLAIM_LOCK_DIR, path.basename(jobId));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverStaleDirectoryLock(lockPath);
      await wait(25);
      continue;
    }
    try {
      return await callback();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new BatchSegmentRepairCodexQueueError(
    "Timed out waiting for the repair job state lock",
    "JOB_STORAGE_BUSY",
  );
}

function normalizeRepairPath(value: string) {
  return String(value || "").replace(/^result\./, "").replace(/^sourceResult\./, "").trim();
}

function cleanRequiredString(value: unknown, label: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new BatchSegmentRepairCodexQueueError(`${label} is missing or too long`);
  return text;
}

function stripJsonBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function resolveRootDir(options: QueueOptions) {
  return path.resolve(options.rootDir || process.cwd());
}

function stateDir(rootDir: string, status: BatchSegmentRepairCodexJobStatus) {
  return path.join(rootDir, TASK_ROOT, STATE_DIRS[status]);
}

function jobPath(rootDir: string, status: BatchSegmentRepairCodexJobStatus, jobId: string) {
  return path.join(stateDir(rootDir, status), `${path.basename(jobId)}.json`);
}

async function ensureQueueDirs(rootDir: string) {
  await Promise.all([
    ...Object.values(STATE_DIRS).map((dir) => mkdir(path.join(rootDir, TASK_ROOT, dir), { recursive: true })),
    mkdir(path.join(rootDir, TASK_ROOT, RESULT_DIR), { recursive: true }),
    mkdir(path.join(rootDir, TASK_ROOT, CLAIM_LOCK_DIR), { recursive: true }),
    mkdir(path.join(rootDir, TASK_ROOT, CREATE_LOCK_DIR), { recursive: true }),
  ]);
}

async function readJobAt(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as BatchSegmentRepairCodexJob;
}

async function writeJobAt(rootDir: string, filePath: string, job: BatchSegmentRepairCodexJob) {
  await atomicReplaceJson(filePath, job, { rootDir });
}
