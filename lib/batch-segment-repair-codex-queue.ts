import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  result: BatchSegmentRepairPatchResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

type QueueOptions = { rootDir?: string };
type ClaimOptions = QueueOptions & { order?: "oldest" | "newest"; runningTimeoutMs?: number };

const TASK_ROOT = ".tmp-batch-segment-repair-codex";
const RESULT_DIR = "results";
const CLAIM_LOCK_DIR = "claim-locks";
const STATE_DIRS: Record<BatchSegmentRepairCodexJobStatus, string> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
};
export class BatchSegmentRepairCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchSegmentRepairCodexQueueError";
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
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeJobAt(jobPath(rootDir, "pending", id), job);
  return job;
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
  if (!located) throw new BatchSegmentRepairCodexQueueError("Batch segment repair job not found");
  return located.job;
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
        await rename(sourcePath, runningPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const now = new Date().toISOString();
      const claimed: BatchSegmentRepairCodexJob = {
        ...candidate.job,
        status: "running",
        leaseId: randomUUID(),
        startedAt: now,
        updatedAt: now,
        error: null,
      };
      await writeJobAt(runningPath, claimed);
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
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const runningPath = jobPath(rootDir, "running", jobId);
  const job = await readJobAt(runningPath);
  assertLease(job, leaseId);
  const result = await readAndValidateRepairResult(job);
  const now = new Date().toISOString();
  const completed: BatchSegmentRepairCodexJob = {
    ...job,
    status: "completed",
    result,
    error: null,
    completedAt: now,
    updatedAt: now,
  };
  await writeJobAt(runningPath, completed);
  await rename(runningPath, jobPath(rootDir, "completed", jobId));
  return completed;
}

export async function failBatchSegmentRepairCodexJob(
  jobId: string,
  leaseId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const runningPath = jobPath(rootDir, "running", jobId);
  const job = await readJobAt(runningPath);
  assertLease(job, leaseId);
  const failed: BatchSegmentRepairCodexJob = {
    ...job,
    status: "failed",
    error: message || "Batch segment repairs-only Codex job failed",
    updatedAt: new Date().toISOString(),
  };
  await writeJobAt(runningPath, failed);
  await rename(runningPath, jobPath(rootDir, "failed", jobId));
  return failed;
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

async function recoverStaleRunningJobs(rootDir: string, runningTimeoutMs = 0) {
  if (!runningTimeoutMs) return;
  const entries = await readdir(stateDir(rootDir, "running"), { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const runningPath = path.join(stateDir(rootDir, "running"), entry.name);
    const job = await readJobAt(runningPath);
    const startedAt = Date.parse(job.startedAt || job.updatedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < runningTimeoutMs) continue;
    const recovered: BatchSegmentRepairCodexJob = {
      ...job,
      status: "pending",
      leaseId: null,
      error: "Repair task returned to pending after lease timeout",
      updatedAt: new Date().toISOString(),
    };
    await writeJobAt(runningPath, recovered);
    try {
      await rename(runningPath, path.join(stateDir(rootDir, "pending"), entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

function assertLease(job: BatchSegmentRepairCodexJob, leaseId: string) {
  if (!leaseId || job.leaseId !== leaseId) {
    throw new BatchSegmentRepairCodexQueueError("Repair job lease is stale or invalid");
  }
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
  ]);
}

async function readJobAt(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as BatchSegmentRepairCodexJob;
}

async function writeJobAt(filePath: string, job: BatchSegmentRepairCodexJob) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
