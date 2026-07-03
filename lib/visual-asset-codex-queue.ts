import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type VisualAssetCodexTaskStatus = "pending" | "running" | "completed" | "failed";
export type VisualAssetCodexJobStatus = "pending" | "running" | "completed" | "failed";
export type VisualAssetEntityType = "CHARACTER" | "SCENE" | "PROP" | "STYLE";
export type VisualAssetGenerationMode = "initial" | "regenerate" | "edit_text" | "edit_image";
export type VisualAssetType = "CHARACTER_TURNAROUND" | "SCENE_KEYART" | "PROP_SHEET";

export type CreateVisualAssetCodexJobInput = {
  projectId: string;
  versionId: string;
  entityId: string;
  entityType: VisualAssetEntityType;
  entityName: string;
  entityKey?: string | null;
  canonicalPrompt?: string | null;
  visualLock?: string | null;
  negativeLock?: string | null;
  mode?: VisualAssetGenerationMode;
  editInstruction?: string | null;
  referenceImageUrl?: string | null;
  size?: string | null;
  quality?: string | null;
};

export type VisualAssetCodexTask = {
  id: string;
  jobId: string;
  projectId: string;
  versionId: string;
  entityId: string;
  entityType: VisualAssetEntityType;
  entityName: string;
  entityKey: string;
  assetType: VisualAssetType;
  mode: VisualAssetGenerationMode;
  prompt: string;
  size: string;
  quality: string;
  status: VisualAssetCodexTaskStatus;
  outputFileName: string;
  outputPath: string;
  imageUrl: string | null;
  error: string | null;
  attempts: number;
  sourceImagePath?: string | null;
  codexLogPath?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type VisualAssetCodexJob = {
  id: string;
  projectId: string;
  versionId: string;
  entityId: string;
  entityType: VisualAssetEntityType;
  entityName: string;
  entityKey: string;
  assetType: VisualAssetType;
  mode: VisualAssetGenerationMode;
  status: VisualAssetCodexJobStatus;
  task: VisualAssetCodexTask;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type QueueOptions = {
  rootDir?: string;
};

type ClaimOptions = QueueOptions & {
  order?: "oldest" | "newest";
  runningTimeoutMs?: number;
};

type CompleteTaskOptions = QueueOptions & {
  sourceImagePath?: string | null;
  codexLogPath?: string | null;
};

const TASK_ROOT = ".tmp-visual-asset-codex";
const JOB_DIR = "jobs";
const QUEUE_LOCK_DIR = "queue.lock";
const QUEUE_LOCK_TIMEOUT_MS = 10_000;
const QUEUE_LOCK_STALE_MS = 60_000;
const TASK_MAX_ATTEMPTS = 3;
const VISUAL_ASSET_DIR = ["public", "project-assets", "visual-assets"];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class VisualAssetCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualAssetCodexQueueError";
  }
}

export async function createVisualAssetCodexJob(
  input: CreateVisualAssetCodexJobInput,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    validateCreateInput(input);

    const now = new Date().toISOString();
    const jobId = createId("visual-asset-job");
    const entityKey = cleanEntityKey(input.entityKey || input.entityName);
    const assetType = resolveAssetType(input.entityType);
    const mode = input.mode || "initial";
    const outputDir = visualAssetOutputDir(rootDir, input.projectId, input.entityId);
    const outputFileName = `${assetType.toLowerCase()}-${entityKey}-${jobId}.png`;
    const taskId = createId("visual-asset-task");

    const task: VisualAssetCodexTask = {
      id: taskId,
      jobId,
      projectId: input.projectId,
      versionId: input.versionId,
      entityId: input.entityId,
      entityType: input.entityType,
      entityName: input.entityName,
      entityKey,
      assetType,
      mode,
      prompt: buildVisualAssetPrompt(input, assetType, entityKey),
      size: input.size || defaultSizeForAssetType(assetType),
      quality: input.quality || "medium",
      status: "pending",
      outputFileName,
      outputPath: path.join(outputDir, outputFileName),
      imageUrl: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    const job: VisualAssetCodexJob = {
      id: jobId,
      projectId: input.projectId,
      versionId: input.versionId,
      entityId: input.entityId,
      entityType: input.entityType,
      entityName: input.entityName,
      entityKey,
      assetType,
      mode,
      status: "pending",
      task,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    await ensureQueueDirs(rootDir);
    await mkdir(outputDir, { recursive: true });
    await writeJob(rootDir, job);
    return job;
  });
}

export async function getVisualAssetCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => readJob(rootDir, jobId));
}

export async function claimNextVisualAssetCodexTask(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const jobs = (await listJobs(rootDir)).map((job) => recoverStaleRunningTask(job, options.runningTimeoutMs));
    await Promise.all(jobs.map((job) => writeJob(rootDir, applyJobStatus(job))));

    const direction = options.order === "newest" ? -1 : 1;
    const candidates = jobs
      .filter((job) => job.task.status === "pending")
      .sort((left, right) => direction * (Date.parse(left.task.createdAt) - Date.parse(right.task.createdAt)));

    const next = candidates[0];
    if (!next) return null;

    const now = new Date().toISOString();
    const task: VisualAssetCodexTask = {
      ...next.task,
      status: "running",
      attempts: (next.task.attempts || 0) + 1,
      startedAt: now,
      updatedAt: now,
      error: null,
    };
    const job = applyJobStatus({ ...next, status: "running", task, updatedAt: now });
    await writeJob(rootDir, job);
    return job.task;
  });
}

export async function completeVisualAssetCodexTask(
  jobId: string,
  options: CompleteTaskOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    await assertValidPng(job.task.outputPath);

    const now = new Date().toISOString();
    const task: VisualAssetCodexTask = {
      ...job.task,
      status: "completed",
      imageUrl: outputPathToUrl(rootDir, job.task.outputPath),
      error: null,
      sourceImagePath: options.sourceImagePath || null,
      codexLogPath: options.codexLogPath || null,
      completedAt: now,
      updatedAt: now,
    };
    const updated = applyJobStatus({ ...job, task, updatedAt: now });
    await writeJob(rootDir, updated);
    return updated;
  });
}

export async function failVisualAssetCodexTask(
  jobId: string,
  message: string,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    const now = new Date().toISOString();
    const shouldRetry = (job.task.attempts || 0) < TASK_MAX_ATTEMPTS;
    const task: VisualAssetCodexTask = {
      ...job.task,
      status: shouldRetry ? "pending" : "failed",
      error: cleanError(message),
      updatedAt: now,
    };
    if (shouldRetry) {
      await rm(job.task.outputPath, { force: true }).catch(() => undefined);
    }
    const updated = applyJobStatus({
      ...job,
      task,
      error: shouldRetry ? null : cleanError(message),
      updatedAt: now,
    });
    await writeJob(rootDir, updated);
    return updated;
  });
}

export async function failVisualAssetCodexJob(
  jobId: string,
  message: string,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  return withQueueLock(rootDir, async () => {
    const job = await readJob(rootDir, jobId);
    const now = new Date().toISOString();
    const updated = {
      ...job,
      status: "failed" as const,
      error: cleanError(message),
      task: {
        ...job.task,
        status: "failed" as const,
        error: cleanError(message),
        updatedAt: now,
      },
      updatedAt: now,
    };
    await writeJob(rootDir, updated);
    return updated;
  });
}

function buildVisualAssetPrompt(
  input: CreateVisualAssetCodexJobInput,
  assetType: VisualAssetType,
  entityKey: string,
) {
  const format = assetFormatInstruction(assetType);
  return [
    `Create one ${format}.`,
    "",
    "Project consistency reference:",
    `Asset name: ${input.entityName}`,
    `Asset key: @${entityKey}`,
    `Asset type: ${input.entityType}`,
    `Generation mode: ${input.mode || "initial"}`,
    "",
    `Canonical description: ${input.canonicalPrompt || input.entityName}`,
    `Visual lock: ${input.visualLock || "Keep this asset stable for all future segments and storyboards."}`,
    `Negative lock: ${input.negativeLock || "No watermark, no captions, no random extra characters, no unrelated props."}`,
    input.editInstruction ? `Edit instruction: ${input.editInstruction}` : "",
    input.referenceImageUrl ? `Reference image URL: ${input.referenceImageUrl}` : "",
    "",
    "Output rules:",
    "Use a production-quality cinematic visual style.",
    "Do not add captions, logos, UI text, watermarks, labels, or explanatory text.",
    "Make the asset easy to reuse as a stable project visual bible reference.",
  ]
    .filter(Boolean)
    .join("\n");
}

function assetFormatInstruction(assetType: VisualAssetType) {
  if (assetType === "CHARACTER_TURNAROUND") {
    return "character turnaround reference sheet with consistent front, side, and back views";
  }
  if (assetType === "PROP_SHEET") {
    return "prop sheet on a clean background with readable shape, material, scale, and use-state";
  }
  return "scene key art reference with clear spatial layout, lighting, palette, and camera-ready atmosphere";
}

function defaultSizeForAssetType(assetType: VisualAssetType) {
  return assetType === "SCENE_KEYART" ? "1024x576" : "1024x1024";
}

function resolveAssetType(entityType: VisualAssetEntityType): VisualAssetType {
  if (entityType === "CHARACTER") return "CHARACTER_TURNAROUND";
  if (entityType === "PROP") return "PROP_SHEET";
  return "SCENE_KEYART";
}

function recoverStaleRunningTask(job: VisualAssetCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0 || job.task.status !== "running" || !job.task.startedAt) return job;
  if (Date.now() - Date.parse(job.task.startedAt) < runningTimeoutMs) return job;
  return applyJobStatus({
    ...job,
    task: {
      ...job.task,
      status: "pending",
      error: "Task was returned to pending after running timeout.",
      updatedAt: new Date().toISOString(),
    },
  });
}

function applyJobStatus(job: VisualAssetCodexJob): VisualAssetCodexJob {
  if (job.task.status === "completed") {
    return { ...job, status: "completed", error: null };
  }
  if (job.task.status === "failed") {
    return { ...job, status: "failed", error: job.task.error || job.error };
  }
  if (job.task.status === "running") {
    return { ...job, status: "running", error: null };
  }
  return { ...job, status: "pending", error: null };
}

async function listJobs(rootDir: string) {
  await ensureQueueDirs(rootDir);
  const dir = path.join(rootDir, TASK_ROOT, JOB_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJob(rootDir, entry.name.replace(/\.json$/, "")).catch(() => null)),
  );
  return jobs.filter(Boolean) as VisualAssetCodexJob[];
}

async function readJob(rootDir: string, jobId: string): Promise<VisualAssetCodexJob> {
  try {
    const raw = await readFile(jobPath(rootDir, jobId), "utf8");
    return JSON.parse(stripBom(raw)) as VisualAssetCodexJob;
  } catch (error: any) {
    throw new VisualAssetCodexQueueError(`Visual asset Codex job not found or unreadable: ${jobId}`);
  }
}

async function writeJob(rootDir: string, job: VisualAssetCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function assertValidPng(filePath: string) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= PNG_SIGNATURE.length) throw new Error("empty");
    const buffer = await readFile(filePath);
    if (!PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) throw new Error("signature");
  } catch {
    throw new VisualAssetCodexQueueError(`Codex did not produce a valid visual asset PNG: ${filePath}`);
  }
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(path.join(rootDir, TASK_ROOT, JOB_DIR), { recursive: true });
}

async function withQueueLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(rootDir, TASK_ROOT, QUEUE_LOCK_DIR);
  await mkdir(path.dirname(lockDir), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(path.join(lockDir, "owner.txt"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      break;
    } catch {
      await removeStaleLock(lockDir).catch(() => undefined);
      if (Date.now() - start > QUEUE_LOCK_TIMEOUT_MS) {
        throw new VisualAssetCodexQueueError("Visual asset image queue is busy; please retry shortly");
      }
      await delay(25);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function removeStaleLock(lockDir: string) {
  const info = await stat(lockDir);
  if (Date.now() - info.mtimeMs > QUEUE_LOCK_STALE_MS) {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function visualAssetOutputDir(rootDir: string, projectId: string, entityId: string) {
  return path.join(rootDir, ...VISUAL_ASSET_DIR, fileSegment(projectId), fileSegment(entityId));
}

function outputPathToUrl(rootDir: string, outputPath: string) {
  const relative = path.relative(path.join(rootDir, "public"), outputPath);
  return `/${relative.split(path.sep).join("/")}`;
}

function jobPath(rootDir: string, jobId: string) {
  return path.join(rootDir, TASK_ROOT, JOB_DIR, `${fileSegment(jobId)}.json`);
}

function validateCreateInput(input: CreateVisualAssetCodexJobInput) {
  if (!input.projectId || !input.versionId || !input.entityId) {
    throw new VisualAssetCodexQueueError("Project id, version id, and entity id are required");
  }
  if (!input.entityName || !input.entityName.trim()) {
    throw new VisualAssetCodexQueueError("Visual asset entity name is required");
  }
  if (!["CHARACTER", "SCENE", "PROP", "STYLE"].includes(input.entityType)) {
    throw new VisualAssetCodexQueueError("Unsupported visual asset entity type");
  }
}

function resolveRootDir(options: QueueOptions) {
  return options.rootDir ? path.resolve(options.rootDir) : process.cwd();
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function cleanEntityKey(value: string) {
  return fileSegment(value || "asset").replace(/-/g, "_");
}

function fileSegment(value: string) {
  return String(value || "item")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";
}

function stripBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function cleanError(message: string) {
  return String(message || "Visual asset Codex task failed").slice(0, 2000);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
