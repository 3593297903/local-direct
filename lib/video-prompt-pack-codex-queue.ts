import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../types";
import type { SegmentContract } from "./batch-segment-contract";
import {
  assertCleanCodexPromptInput,
  buildChinesePromptLexiconBlock,
  compileCodexPromptText,
  segmentContractToChineseRenderBlock,
} from "./codex-prompt-input-compiler";
import { readVideoPromptOutputJson } from "./video-prompt-codex-queue";
import {
  buildSegmentResultHash,
  type SegmentCoverageSidecar,
} from "./batch-event-coverage";
import { applyPromptSafetyPolicyDeep, type PromptSafetyDiff } from "./prompt-safety-policy";
import { readCodexRuntimeHealth } from "./codex-runtime-health";
import {
  atomicReplaceJson,
  claimNextFileJob,
  ensureFileJobStore,
  FileJobLeaseError,
  finishPendingFileJob,
  finishRunningFileJob,
  getFileJob,
  putPendingFileJob,
} from "./file-job-store";

export type VideoPromptPackCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type VideoPromptPackSegmentInput = {
  episodeIndex: number;
  title: string;
  script: string;
  renderInputScript: string;
  duration: string;
  shotCount?: number;
  segmentContract?: SegmentContract;
};

export type CreateVideoPromptPackCodexJobInput = {
  idempotencyKey?: string;
  projectId?: string;
  mode?: VideoPromptPackCodexMode;
  coverageSidecarEnabled?: boolean;
  segments: VideoPromptPackSegmentInput[];
};

export type VideoPromptPackSegmentTask = VideoPromptPackSegmentInput & {
  outputFileName: string;
  outputPath: string;
  coverageOutputPath: string;
};

export type VideoPromptPackCodexResult = {
  segments: Array<{
    episodeIndex: number;
    outputPath: string;
    coverageOutputPath: string;
    result: Record<string, unknown>;
    coverageSidecar: SegmentCoverageSidecar | null;
  }>;
};

export type VideoPromptPackCodexJob = {
  id: string;
  idempotencyKey: string | null;
  projectId: string | null;
  mode: VideoPromptPackCodexMode;
  coverageSidecarEnabled: boolean;
  safetyDiffs: PromptSafetyDiff[];
  segments: VideoPromptPackSegmentTask[];
  prompt: string;
  status: VideoPromptPackCodexJobStatus;
  leaseId: string | null;
  workerId: string | null;
  heartbeatAt?: string;
  attempt: number;
  fencingToken: number;
  result: VideoPromptPackCodexResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type VideoPromptPackCodexMode = "standard" | "strictUtf8";

type QueueOptions = {
  rootDir?: string;
};

type ClaimOptions = QueueOptions & {
  order?: "oldest" | "newest";
  runningTimeoutMs?: number;
  workerId?: string;
};

const TASK_ROOT = ".tmp-video-prompt-pack-codex";
const LEGACY_JOB_DIR = "jobs";
const LEGACY_MIGRATION_LOCK_DIR = "legacy-migration.lock";
const RESULT_DIR = "results";
const MAX_PACK_SEGMENTS = 5;

export class VideoPromptPackCodexQueueError extends Error {
  readonly code: string;

  constructor(message: string, code = "RENDER_PACK_JOB_INVALID") {
    super(message);
    this.name = "VideoPromptPackCodexQueueError";
    this.code = code;
  }
}

export async function createVideoPromptPackCodexJob(
  input: CreateVideoPromptPackCodexJobInput,
  options: QueueOptions = {},
) {
  validateCreateInput(input);

  const rootDir = resolveRootDir(options);
  await ensureFileJobStore(rootDir, TASK_ROOT);
  await migrateLegacyVideoPromptPackJobs(rootDir);
  const now = new Date().toISOString();
  const idempotencyKey = normalizeRenderPackIdempotencyKey(input.idempotencyKey);
  const jobId = idempotencyKey
    ? `video-prompt-pack-job-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`
    : createId("video-prompt-pack-job");
  if (idempotencyKey) {
    try {
      return await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "File job not found") throw error;
    }
  }
  const segments = input.segments.map((segment) => {
    const outputFileName = episodeFileName(segment.episodeIndex);
    return {
      ...segment,
      outputFileName,
      outputPath: path.join(resultDir(rootDir), fileSegment(jobId), outputFileName),
      coverageOutputPath: path.join(resultDir(rootDir), fileSegment(jobId), coverageFileName(segment.episodeIndex)),
    };
  });
  const mode = input.mode === "standard" ? "standard" : "strictUtf8";
  const coverageSidecarEnabled = input.coverageSidecarEnabled !== false;
  const modelPrepass = applyPromptSafetyPolicyDeep(segments, { phase: "render" });
  const prompt = buildVideoPromptPackCodexPrompt(jobId, modelPrepass.sourceTextForModel, mode, coverageSidecarEnabled);
  assertCleanCodexPromptInput(prompt, "Video prompt render pack prompt");
  const job: VideoPromptPackCodexJob = {
    id: jobId,
    idempotencyKey,
    projectId: input.projectId || null,
    mode,
    coverageSidecarEnabled,
    safetyDiffs: modelPrepass.safetyDiffs,
    segments,
    prompt,
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
  return putPendingFileJob(rootDir, TASK_ROOT, job);
}

export async function getVideoPromptPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  await migrateLegacyVideoPromptPackJobs(rootDir);
  try {
    const job = normalizeStoredRenderPackJob(await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId));
    return syncAndSaveJob(rootDir, job);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "JOB_STORAGE_BUSY") {
      throw new VideoPromptPackCodexQueueError("Render Pack queue storage is temporarily busy", "JOB_STORAGE_BUSY");
    }
    throw new VideoPromptPackCodexQueueError(
      error instanceof Error && error.message === "File job not found"
        ? "Video prompt render pack Codex job not found"
        : "Video prompt render pack Codex job could not be read",
      error instanceof Error && error.message === "File job not found" ? "JOB_NOT_FOUND" : "RENDER_PACK_JOB_INVALID",
    );
  }
}

export async function claimNextVideoPromptPackCodexJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  await migrateLegacyVideoPromptPackJobs(rootDir);
  return claimNextFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, {
    order: options.order,
    runningTimeoutMs: options.runningTimeoutMs,
    workerId: options.workerId,
    canRecoverRunningJob: (job) => canRecoverRenderPackJob(rootDir, job, options.runningTimeoutMs),
  });
}

export async function completeVideoPromptPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = normalizeStoredRenderPackJob(await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId));
  assertRenderPackLease(job, leaseId, fencingToken);
  if (job.status === "completed") return job;
  if (job.status === "pending") {
    throw new VideoPromptPackCodexQueueError("Render Pack lease is stale or invalid", "JOB_LEASE_LOST");
  }
  const result = await readPackResult(job);
  const now = new Date().toISOString();
  const updated: VideoPromptPackCodexJob = {
    ...job,
    status: "completed",
    result,
    error: null,
    completedAt: now,
    updatedAt: now,
  };
  if (job.status === "running") {
    return finishRunningFileJob(rootDir, TASK_ROOT, updated, "completed");
  }
  await persistRenderPackState(rootDir, job.status, updated);
  return updated;
}

export async function failVideoPromptPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = normalizeStoredRenderPackJob(await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId));
  assertRenderPackLease(job, leaseId, fencingToken);
  if (job.status === "failed") return job;
  if (job.status !== "running") {
    throw new VideoPromptPackCodexQueueError("Completed Render Pack cannot be failed", "JOB_ALREADY_COMPLETED");
  }
  const updated = applyJobStatus({
    ...job,
    status: "failed",
    error: message || "Codex video prompt render pack generation failed",
    updatedAt: new Date().toISOString(),
  });
  return finishRunningFileJob(rootDir, TASK_ROOT, updated, "failed");
}

function assertRenderPackLease(job: VideoPromptPackCodexJob, leaseId: string, fencingToken: number) {
  if (!leaseId || job.leaseId !== leaseId || !Number.isInteger(fencingToken) || job.fencingToken !== fencingToken) {
    throw new VideoPromptPackCodexQueueError("Render Pack lease is stale or invalid", "JOB_LEASE_LOST");
  }
}

function buildVideoPromptPackCodexPrompt(
  jobId: string,
  segments: VideoPromptPackSegmentTask[],
  mode: VideoPromptPackCodexMode,
  coverageSidecarEnabled: boolean,
) {
  const segmentInstructions = segments.flatMap((segment) => [
    `段落 ${segment.episodeIndex}：${compileCodexPromptText(segment.title)}`,
    `时长：${segment.duration}`,
    `镜头数量锁：${segment.shotCount || "按渲染稿锁定"}`,
    segment.segmentContract ? segmentContractToChineseRenderBlock(segment.segmentContract) : "",
    `Output path: ${segment.outputPath}`,
    coverageSidecarEnabled ? `Optional internal coverage sidecar path: ${segment.coverageOutputPath}` : "",
    "渲染输入：",
    compileCodexPromptText(segment.renderInputScript),
    "",
  ]);
  const lexiconBlock = buildChinesePromptLexiconBlock(
    segments.flatMap((segment) => [
      segment.title,
      segment.script,
      segment.renderInputScript,
      segment.segmentContract,
    ]),
  );
  const strictUtf8Instructions =
    mode === "strictUtf8"
      ? [
          "",
          "STRICT_UTF8_RECOVERY_MODE:",
          "- A previous Render Pack attempt likely produced damaged Chinese JSON with excessive question marks.",
          "- You must write JSON only from a Node.js script or node -e code using fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), \"utf8\").",
          "- Do not use PowerShell Set-Content, Out-File, shell redirection, cmd echo, or here-strings for file writing.",
          "- After writing each file, read it back with fs.readFileSync(outputPath, \"utf8\"), parse JSON, and reject output that has replacement characters or excessive question marks.",
          "- Preserve Chinese text as Chinese characters.",
        ]
      : [];

  return [
    "You are handling a Local Director Render Pack task from a local Codex CLI worker.",
    "A Render Pack only batches local CLI work. Every segment must still be rendered as a complete independent Chinese Local Director segment video prompt JSON.",
    "Do not open a browser. Do not ask the user to copy or paste. Do not call network providers.",
    "",
    "Hard quality rules:",
    "- Write one separate JSON file per segment to the exact output path shown below.",
    "- Each JSON must be a complete Local Director video prompt result, not a summary and not a combined array.",
    "- Each JSON must include title, contentType, duration, style, diagnosis, optimizedScript, workflow.fullVideoPrompt, workflow.fullNegativePrompt, workflow.concisePrompt, and storyboard.",
    "- Every storyboard shot must include shotNumber, timeRange, scene, visual, shotType, composition, cameraMovement, lighting, sound, dialogue, emotion, transition, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt.",
    "- Keep full standalone segment quality: a 4-shot segment should usually have workflow.fullVideoPrompt with at least 1400 meaningful Chinese characters; 3-shot segments should usually have at least 1100.",
    "- Do not make thin shots. visual, composition, lighting, sound, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt must be concrete, shootable text instead of short labels.",
    "- videoPrompt must describe the full moving image for that shot with action, space, camera behavior, light, sound, emotion, and continuity. Do not output one-sentence summaries.",
    "- Do not use 同上, 如上, 略, 参考上一段, continue as above, or any placeholder that depends on another segment.",
    "- If there is no spoken line, dialogue must be a concrete no-dialogue value such as \"无\" or \"none\".",
    "- 保留每段的具体渲染输入、镜头数量锁、项目记忆连续性和源文案事件。",
    "- User-facing fields must use natural Chinese labels. Do not output hyphenated English internal IDs, schema names, file-format names, or engineering type names in title, contentType, scene, visual, workflow, or storyboard fields.",
    "- The main episode JSON must remain a bare video prompt result. Never put coverage receipts, confidence, analysis, or internal metadata inside it.",
    "",
    lexiconBlock,
    lexiconBlock ? "" : "",
    "File writing requirements:",
    "- Write all JSON files as UTF-8.",
    "- Prefer Node.js fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), \"utf8\").",
    "- Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    ...strictUtf8Instructions,
    "",
    `Render Pack ID: ${jobId}`,
    `Pack size: ${segments.length}`,
    "",
    "段落输入：",
    ...segmentInstructions,
    "Completion requirements:",
    "1. Create every output directory if it does not exist.",
    "2. Write every segment JSON file to the exact output path.",
    "3. Read every JSON file back and confirm it parses.",
    ...(coverageSidecarEnabled
      ? [
          "4. After the main JSON parses, you may write the optional coverage sidecar for v2 event slots. It must contain only schemaVersion=1, segmentIndex, contractHash, and receipts with slotId plus up to two path/quote evidence items.",
          "5. Do not write resultHash in the model sidecar. Local Director computes and injects resultHash only after the main result is read and validated.",
          "6. Coverage quotes must be exact short substrings from optimizedScript or allowed storyboard user fields. Do not output covered, confidence, analysis, explanations, repairs, or full prompt content in the sidecar.",
          "7. Sidecar failure must never modify or delete the main episode JSON.",
        ]
      : []),
    "8. Final reply must be exactly one line: DONE.",
  ].join("\n");
}

async function syncAndSaveJob(rootDir: string, job: VideoPromptPackCodexJob) {
  const synced = await syncJobFromOutputFiles(job);
  const finalized = applyJobStatus(synced);
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    if (finalized.status === "completed" && (job.status === "running" || job.status === "pending")) {
      try {
        return job.status === "running"
          ? await finishRunningFileJob(rootDir, TASK_ROOT, finalized, "completed")
          : await finishPendingFileJob(rootDir, TASK_ROOT, finalized, "completed");
      } catch (error) {
        if (error instanceof FileJobLeaseError) {
          return normalizeStoredRenderPackJob(
            await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, job.id),
          );
        }
        throw error;
      }
    }
    await persistRenderPackState(rootDir, job.status, finalized);
  }
  return finalized;
}

async function syncJobFromOutputFiles(job: VideoPromptPackCodexJob) {
  if (job.status === "completed") return job;
  if (!(await hasValidPackResult(job))) return job;

  return {
    ...job,
    status: "completed" as const,
    result: await readPackResult(job),
    error: null,
    completedAt: job.completedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function applyJobStatus(job: VideoPromptPackCodexJob): VideoPromptPackCodexJob {
  if (job.status === "completed") return { ...job, error: null };
  if (job.status === "running") return { ...job, error: null };
  if (job.status === "failed") return job;
  return { ...job, status: "pending", error: null };
}

async function readPackResult(job: VideoPromptPackCodexJob): Promise<VideoPromptPackCodexResult> {
  const segments = await Promise.all(
    job.segments.map(async (segment) => {
      const result = await readVideoPromptOutputJson(segment.outputPath, `${segment.script}\n${segment.renderInputScript}`);
      return {
        episodeIndex: segment.episodeIndex,
        outputPath: segment.outputPath,
        coverageOutputPath: segment.coverageOutputPath,
        result,
        coverageSidecar: job.coverageSidecarEnabled === false ? null : await readOptionalCoverageSidecar(segment, result),
      };
    }),
  );
  return { segments: segments.sort((left, right) => left.episodeIndex - right.episodeIndex) };
}

async function readOptionalCoverageSidecar(
  segment: VideoPromptPackSegmentTask,
  result: Record<string, unknown>,
): Promise<SegmentCoverageSidecar | null> {
  if (!segment.segmentContract?.requiredEventSlots?.length) return null;
  try {
    const parsed = JSON.parse(await readFile(segment.coverageOutputPath, "utf8")) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1
      || Number(parsed.segmentIndex) !== segment.episodeIndex
      || parsed.contractHash !== segment.segmentContract.contractHash
      || !Array.isArray(parsed.receipts)
    ) return null;
    const knownSlots = new Set(segment.segmentContract.requiredEventSlots.map((slot) => slot.id));
    const receipts = parsed.receipts.flatMap((receipt) => {
      if (!receipt || typeof receipt !== "object") return [];
      const record = receipt as Record<string, unknown>;
      const slotId = String(record.slotId || "");
      if (!knownSlots.has(slotId) || !Array.isArray(record.evidence)) return [];
      const importance = segment.segmentContract?.requiredEventSlots.find((slot) => slot.id === slotId)?.importance;
      const evidence = record.evidence.slice(0, importance === "blocking" ? 2 : 1).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const pathValue = String(entry.path || "").trim();
        const quote = String(entry.quote || "").trim();
        if (!pathValue || !quote || quote.length > 80) return [];
        return [{ path: pathValue, quote }];
      });
      return evidence.length ? [{ slotId, evidence }] : [];
    });
    if (!receipts.length) return null;
    return {
      schemaVersion: 1,
      segmentIndex: segment.episodeIndex,
      contractHash: segment.segmentContract.contractHash,
      resultHash: buildSegmentResultHash(result as AnalysisResult),
      receipts,
    };
  } catch {
    return null;
  }
}

async function hasValidPackResult(job: VideoPromptPackCodexJob) {
  try {
    for (const segment of job.segments) {
      const fileStat = await stat(segment.outputPath);
      if (!fileStat.isFile() || fileStat.size <= 0) return false;
      await readVideoPromptOutputJson(segment.outputPath, `${segment.script}\n${segment.renderInputScript}`);
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeStoredRenderPackJob(job: VideoPromptPackCodexJob): VideoPromptPackCodexJob {
  return {
    ...job,
    idempotencyKey: job.idempotencyKey || null,
    mode: job.mode === "standard" ? "standard" : "strictUtf8",
    leaseId: job.leaseId || null,
    workerId: job.workerId || null,
    attempt: Math.max(0, Number(job.attempt) || 0),
    fencingToken: Math.max(0, Number(job.fencingToken) || 0),
  };
}

async function canRecoverRenderPackJob(
  rootDir: string,
  job: VideoPromptPackCodexJob,
  runningTimeoutMs = 0,
) {
  const runtime = await readCodexRuntimeHealth("video-prompt-pack", {
    rootDir,
    maxAgeMs: Math.min(Math.max(30_000, Math.floor(runningTimeoutMs / 4)), 90_000),
  });
  if (runtime.status === "healthy") return false;
  const recentWindowMs = Math.min(Math.max(30_000, Math.floor(runningTimeoutMs / 3)), 5 * 60_000);
  for (const segment of job.segments) {
    try {
      const outputStat = await stat(segment.outputPath);
      if (Date.now() - outputStat.mtimeMs < recentWindowMs) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}

async function persistRenderPackState(
  rootDir: string,
  previousStatus: VideoPromptPackCodexJobStatus,
  job: VideoPromptPackCodexJob,
) {
  await ensureFileJobStore(rootDir, TASK_ROOT);
  const target = renderPackStatePath(rootDir, job.status, job.id);
  await atomicReplaceJson(target, job, { rootDir });
  if (previousStatus !== job.status) {
    await rm(renderPackStatePath(rootDir, previousStatus, job.id), { force: true });
  }
}

async function migrateLegacyVideoPromptPackJobs(rootDir: string) {
  await ensureFileJobStore(rootDir, TASK_ROOT);
  const lockPath = path.join(rootDir, TASK_ROOT, LEGACY_MIGRATION_LOCK_DIR);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs <= 60_000) return;
        await rm(lockPath, { recursive: true, force: true });
        return migrateLegacyVideoPromptPackJobs(rootDir);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
          return migrateLegacyVideoPromptPackJobs(rootDir);
        }
        throw lockError;
      }
    }
    throw error;
  }
  try {
    await migrateLegacyVideoPromptPackJobsUnlocked(rootDir);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function migrateLegacyVideoPromptPackJobsUnlocked(rootDir: string) {
  const legacyDir = path.join(rootDir, TASK_ROOT, LEGACY_JOB_DIR);
  const entries = await readdir(legacyDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const legacyPath = path.join(legacyDir, entry.name);
    let legacy: VideoPromptPackCodexJob;
    try {
      legacy = normalizeStoredRenderPackJob(JSON.parse(await readFile(legacyPath, "utf8")) as VideoPromptPackCodexJob);
    } catch {
      continue;
    }
    try {
      await getFileJob(rootDir, TASK_ROOT, legacy.id);
      await rm(legacyPath, { force: true });
      continue;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "File job not found") throw error;
    }
    const migrated = legacy.status === "running"
      ? {
          ...legacy,
          status: "failed" as const,
          leaseId: null,
          workerId: null,
          error: "Legacy running Render Pack was not re-executed automatically; create a new idempotent job to retry.",
          updatedAt: new Date().toISOString(),
        }
      : legacy;
    await atomicReplaceJson(renderPackStatePath(rootDir, migrated.status, migrated.id), migrated, { rootDir });
    await rm(legacyPath, { force: true });
  }
}

function validateCreateInput(input: CreateVideoPromptPackCodexJobInput) {
  if (!Array.isArray(input.segments) || input.segments.length < 1) {
    throw new VideoPromptPackCodexQueueError("Render pack must contain at least one segment");
  }
  if (input.segments.length > MAX_PACK_SEGMENTS) {
    throw new VideoPromptPackCodexQueueError(`Render pack cannot contain more than ${MAX_PACK_SEGMENTS} segments`);
  }

  const seen = new Set<number>();
  for (const segment of input.segments) {
    if (!Number.isInteger(segment.episodeIndex) || segment.episodeIndex < 1) {
      throw new VideoPromptPackCodexQueueError("Render pack segment is missing episodeIndex");
    }
    if (seen.has(segment.episodeIndex)) {
      throw new VideoPromptPackCodexQueueError(`Render pack contains duplicate segment ${segment.episodeIndex}`);
    }
    seen.add(segment.episodeIndex);
    if (!String(segment.title || "").trim()) {
      throw new VideoPromptPackCodexQueueError(`Render pack segment ${segment.episodeIndex} is missing title`);
    }
    if (String(segment.script || "").trim().length < 5) {
      throw new VideoPromptPackCodexQueueError(`Render pack segment ${segment.episodeIndex} script is too short`);
    }
    if (String(segment.renderInputScript || "").trim().length < 5) {
      throw new VideoPromptPackCodexQueueError(`Render pack segment ${segment.episodeIndex} renderInputScript is too short`);
    }
    if (String(segment.duration || "").trim().length < 1) {
      throw new VideoPromptPackCodexQueueError(`Render pack segment ${segment.episodeIndex} is missing duration`);
    }
  }
}

function resolveRootDir(options: QueueOptions) {
  return path.resolve(options.rootDir || process.cwd());
}

function normalizeRenderPackIdempotencyKey(value: unknown) {
  const key = String(value || "").trim();
  if (!key) return null;
  if (key.length > 400) throw new VideoPromptPackCodexQueueError("Render pack idempotencyKey is too long");
  return key;
}

function resultDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, RESULT_DIR);
}

function renderPackStatePath(
  rootDir: string,
  status: VideoPromptPackCodexJobStatus,
  jobId: string,
) {
  return path.join(rootDir, TASK_ROOT, status, `${fileSegment(jobId)}.json`);
}

function episodeFileName(episodeIndex: number) {
  return `episode-${String(episodeIndex).padStart(3, "0")}.json`;
}

function coverageFileName(episodeIndex: number) {
  return `episode-${String(episodeIndex).padStart(3, "0")}.coverage.json`;
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
