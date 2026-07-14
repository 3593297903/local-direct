import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../types";
import type { SegmentContract, SegmentEvidenceField } from "./batch-segment-contract";
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
  assertFinalizationFilesStable,
  buildFinalizedResultRef,
  CODEX_FINALIZATION_PROTOCOL_VERSION,
  CodexJobFinalizationError,
  createJobStagingDirectory,
  hashCanonicalJson,
  publishFinalizedJob,
  readAndValidateFinalManifest,
  readAndValidateRecoverableFinalManifest,
  readStrictFinalizationJson,
  type CodexFinalizedResultRef,
  writeFinalManifest,
} from "./codex-job-finalization";
import {
  atomicReplaceJson,
  claimNextFileJob,
  ensureFileJobStore,
  FileJobLeaseError,
  finishPendingFileJob,
  finishRunningFileJob,
  getFileJob,
  listFileJobsByStatus,
  putPendingFileJob,
  readRunningFileJob,
  updateRunningFileJob,
} from "./file-job-store";

export type VideoPromptPackCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type VideoPromptPackCodexJobStage =
  | "pending"
  | "claimed"
  | "waiting_slot"
  | "executing"
  | "finalizing"
  | "completed"
  | "failed";

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
    resultHash: string;
    coverageSidecar: SegmentCoverageSidecar | null;
  }>;
};

type VideoPromptPackOutputTemplate = {
  segments: VideoPromptPackSegmentTask[];
  prompt: string;
};

export type VideoPromptPackCodexJob = {
  id: string;
  protocolVersion: 1 | 2;
  stage: VideoPromptPackCodexJobStage;
  idempotencyKey: string | null;
  projectId: string | null;
  mode: VideoPromptPackCodexMode;
  coverageSidecarEnabled: boolean;
  safetyDiffs: PromptSafetyDiff[];
  segments: VideoPromptPackSegmentTask[];
  prompt: string;
  outputTemplate: VideoPromptPackOutputTemplate | null;
  status: VideoPromptPackCodexJobStatus;
  leaseId: string | null;
  workerId: string | null;
  heartbeatAt?: string;
  attempt: number;
  fencingToken: number;
  stagingDir: string | null;
  sourceHash: string;
  contractHash: string | null;
  resultRef: CodexFinalizedResultRef | null;
  resultAvailable: boolean;
  result: VideoPromptPackCodexResult | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  claimedAt?: string;
  waitingSlotAt?: string;
  executingAt?: string;
  codexExitedAt?: string;
  finalizingAt?: string;
  completedAt?: string;
  failedAt?: string;
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
  const sourceHash = hashCanonicalJson(segments.map((segment) => ({
    episodeIndex: segment.episodeIndex,
    title: segment.title,
    script: segment.script,
    renderInputScript: segment.renderInputScript,
    duration: segment.duration,
    shotCount: segment.shotCount || null,
  })));
  const contractHash = hashCanonicalJson(segments.map((segment) => ({
    episodeIndex: segment.episodeIndex,
    contractHash: segment.segmentContract?.contractHash || null,
  })));
  const job: VideoPromptPackCodexJob = {
    id: jobId,
    protocolVersion: CODEX_FINALIZATION_PROTOCOL_VERSION,
    stage: "pending",
    idempotencyKey,
    projectId: input.projectId || null,
    mode,
    coverageSidecarEnabled,
    safetyDiffs: modelPrepass.safetyDiffs,
    segments,
    prompt,
    outputTemplate: { segments, prompt },
    status: "pending",
    leaseId: null,
    workerId: null,
    attempt: 0,
    fencingToken: 0,
    stagingDir: null,
    sourceHash,
    contractHash,
    resultRef: null,
    resultAvailable: false,
    result: null,
    error: null,
    errorCode: null,
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
    if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) return syncAndSaveJob(rootDir, job);
    if (job.status !== "completed") {
      return { ...job, result: null, resultAvailable: false };
    }
    return validatePublishedRenderPackJob(rootDir, job);
  } catch (error) {
    if (error instanceof CodexJobFinalizationError) throw mapRenderFinalizationError(error);
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
  await recoverFinalizedVideoPromptPackCodexJobs(rootDir, options.runningTimeoutMs);
  const claimed = await claimNextFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, {
    order: options.order,
    runningTimeoutMs: options.runningTimeoutMs,
    workerId: options.workerId,
    canRecoverRunningJob: (job) => canRecoverRenderPackJob(rootDir, job, options.runningTimeoutMs),
    canClaimPendingJob: (job) => normalizeStoredRenderPackJob(job).protocolVersion === CODEX_FINALIZATION_PROTOCOL_VERSION,
  });
  if (!claimed) return null;
  const normalized = normalizeStoredRenderPackJob(claimed);
  if (normalized.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) {
    throw new VideoPromptPackCodexQueueError(
      "Protocol v2 worker cannot claim a legacy Render Pack job",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  const stagingDir = await createJobStagingDirectory({
    rootDir,
    namespace: TASK_ROOT,
    jobId: normalized.id,
    leaseId: normalized.leaseId!,
    fencingToken: normalized.fencingToken,
  });
  const staged = bindRenderPackJobToStaging(normalized, stagingDir);
  return updateRunningFileJob(rootDir, TASK_ROOT, normalized.id, normalized.leaseId!, normalized.fencingToken, {
    ...staged,
    stage: "claimed",
    claimedAt: normalized.claimedAt || normalized.startedAt || new Date().toISOString(),
    error: null,
    errorCode: null,
  });
}

export async function updateVideoPromptPackCodexJobStage(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  stage: Extract<VideoPromptPackCodexJobStage, "waiting_slot" | "executing" | "finalizing">,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const allowedPrevious: Record<typeof stage, VideoPromptPackCodexJobStage[]> = {
    waiting_slot: ["claimed", "waiting_slot"],
    executing: ["claimed", "waiting_slot", "executing"],
    finalizing: ["executing", "finalizing"],
  };
  return updateRunningFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId, leaseId, fencingToken, (current) => {
    const normalized = normalizeStoredRenderPackJob(current);
    if (!allowedPrevious[stage].includes(normalized.stage)) {
      throw new VideoPromptPackCodexQueueError(
        `Render Pack cannot transition from ${normalized.stage} to ${stage}`,
        "FINALIZATION_IDENTITY_MISMATCH",
      );
    }
    const timestamp = new Date().toISOString();
    return {
      ...normalized,
      stage,
      ...(stage === "waiting_slot" ? { waitingSlotAt: normalized.waitingSlotAt || timestamp } : {}),
      ...(stage === "executing" ? { executingAt: normalized.executingAt || timestamp } : {}),
      ...(stage === "finalizing" ? { finalizingAt: normalized.finalizingAt || timestamp } : {}),
    };
  });
}

export async function finalizeVideoPromptPackCodexJobFiles(
  task: VideoPromptPackCodexJob,
  options: QueueOptions & { codexExitCode: number; stabilityDelayMs?: number },
) {
  const rootDir = resolveRootDir(options);
  if (!task.leaseId || !task.stagingDir) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack finalization requires an active staging lease",
      "FINALIZATION_STALE_FENCE",
    );
  }
  let stored: VideoPromptPackCodexJob;
  try {
    ({ job: stored } = await readRunningFileJob<VideoPromptPackCodexJob>(
      rootDir,
      TASK_ROOT,
      task.id,
      task.leaseId,
      task.fencingToken,
    ));
  } catch (error) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack finalization lease is stale or invalid",
      "FINALIZATION_STALE_FENCE",
    );
  }
  const job = normalizeStoredRenderPackJob(stored);
  if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION || job.stagingDir !== task.stagingDir) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack staging identity does not match the active lease",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  if (job.stage !== "finalizing") {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack must enter finalizing before publication",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  if (options.codexExitCode !== 0) {
    throw new VideoPromptPackCodexQueueError(
      `Codex process exited with code ${options.codexExitCode}`,
      "CODEX_PROCESS_FAILED",
    );
  }

  const validated = await validateRenderPackStaging(job, options.stabilityDelayMs);
  const segmentIndexes = validated.result.segments.map((segment) => segment.episodeIndex);
  const resultHash = hashCanonicalJson(renderPackResultProjection(validated.result));
  const identity = {
    rootDir,
    namespace: TASK_ROOT,
    jobId: job.id,
    taskClass: "render_pack" as const,
    leaseId: job.leaseId!,
    fencingToken: job.fencingToken,
    sourceHash: job.sourceHash,
    contractHash: job.contractHash || undefined,
    segmentIndexes,
    resultHash,
  };
  await writeFinalManifest({
    ...identity,
    stagingDir: job.stagingDir,
    outputFiles: validated.outputFiles,
    codexExitCode: options.codexExitCode,
  });
  const resultRef = await publishFinalizedJob({ ...identity, stagingDir: job.stagingDir });
  await updateRunningFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, job.id, job.leaseId!, job.fencingToken, {
    stage: "finalizing",
    resultRef,
    resultAvailable: false,
    codexExitedAt: new Date().toISOString(),
  });
  return { resultRef, resultHash, contractHash: job.contractHash, segmentIndexes };
}

export async function completeVideoPromptPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  resultRefOrOptions: CodexFinalizedResultRef | QueueOptions,
  options: QueueOptions = {},
) {
  let resultRef: CodexFinalizedResultRef | null;
  let queueOptions: QueueOptions;
  if (isFinalizedResultRef(resultRefOrOptions)) {
    resultRef = resultRefOrOptions;
    queueOptions = options;
  } else {
    resultRef = null;
    queueOptions = resultRefOrOptions;
  }
  const rootDir = resolveRootDir(queueOptions);
  const job = normalizeStoredRenderPackJob(await getFileJob<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, jobId));
  assertRenderPackLease(job, leaseId, fencingToken);
  if (!resultRef) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack has not been finalized by the active worker",
      "FINALIZATION_OUTPUT_MISSING",
    );
  }
  if (job.status === "completed") {
    if (!sameResultRef(job.resultRef, resultRef)) {
      throw new VideoPromptPackCodexQueueError(
        "Completed Render Pack result reference does not match",
        "FINALIZATION_IDENTITY_MISMATCH",
      );
    }
    return validatePublishedRenderPackJob(rootDir, job);
  }
  if (job.status !== "running" || job.stage !== "finalizing" || !sameResultRef(job.resultRef, resultRef)) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack has not been finalized by the active worker",
      "FINALIZATION_OUTPUT_MISSING",
    );
  }
  const publishedDir = resolveRenderPackResultDirectory(rootDir, resultRef);
  const manifest = await readAndValidateFinalManifest({
    directory: publishedDir,
    expected: renderPackFinalizationIdentity(job, resultRef.resultHash),
  });
  const result = await readPackResult(bindRenderPackJobToPublishedResult(job, publishedDir), true);
  if (hashCanonicalJson(renderPackResultProjection(result)) !== manifest.resultHash) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack canonical result hash does not match its manifest",
      "FINALIZATION_HASH_MISMATCH",
    );
  }
  const now = new Date().toISOString();
  const updated: VideoPromptPackCodexJob = {
    ...job,
    status: "completed",
    stage: "completed",
    resultRef,
    resultAvailable: true,
    result: null,
    error: null,
    errorCode: null,
    completedAt: now,
    updatedAt: now,
  };
  const persisted = await finishRunningFileJob(rootDir, TASK_ROOT, updated, "completed");
  return { ...persisted, result };
}

export async function failVideoPromptPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  message: string | undefined,
  errorCode: string | undefined,
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
    stage: "failed",
    resultAvailable: false,
    result: null,
    error: message || "Codex video prompt render pack generation failed",
    errorCode: errorCode || null,
    failedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return finishRunningFileJob(rootDir, TASK_ROOT, updated, "failed");
}

export function toVideoPromptPackCodexJobStatusDto(job: VideoPromptPackCodexJob) {
  return {
    id: job.id,
    protocolVersion: job.protocolVersion,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.claimedAt ? { claimedAt: job.claimedAt } : {}),
    ...(job.waitingSlotAt ? { waitingSlotAt: job.waitingSlotAt } : {}),
    ...(job.executingAt ? { executingAt: job.executingAt } : {}),
    ...(job.heartbeatAt ? { heartbeatAt: job.heartbeatAt } : {}),
    ...(job.finalizingAt ? { finalizingAt: job.finalizingAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    error: job.error,
    resultAvailable: job.protocolVersion === 1
      ? job.status === "completed" && Boolean(job.result)
      : job.resultAvailable,
    ...(job.resultRef?.resultHash ? { resultHash: job.resultRef.resultHash } : {}),
    ...(job.status === "completed" && job.resultAvailable ? { result: job.result } : {}),
  };
}

function assertRenderPackLease(job: VideoPromptPackCodexJob, leaseId: string, fencingToken: number) {
  if (!leaseId || job.leaseId !== leaseId || !Number.isInteger(fencingToken) || job.fencingToken !== fencingToken) {
    throw new VideoPromptPackCodexQueueError("Render Pack lease is stale or invalid", "FINALIZATION_STALE_FENCE");
  }
}

function isFinalizedResultRef(value: CodexFinalizedResultRef | QueueOptions): value is CodexFinalizedResultRef {
  return Boolean(value && typeof value === "object"
    && typeof (value as CodexFinalizedResultRef).resultHash === "string"
    && typeof (value as CodexFinalizedResultRef).relativePath === "string"
    && typeof (value as CodexFinalizedResultRef).manifestRelativePath === "string");
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

async function readPackResult(
  job: VideoPromptPackCodexJob,
  strictPublication = false,
): Promise<VideoPromptPackCodexResult> {
  const segments = await Promise.all(
    job.segments.map(async (segment) => {
      const result = strictPublication
        ? await readStrictRenderResult(segment)
        : await readVideoPromptOutputJson(segment.outputPath, `${segment.script}\n${segment.renderInputScript}`);
      const resultHash = buildSegmentResultHash(result as AnalysisResult);
      return {
        episodeIndex: segment.episodeIndex,
        outputPath: segment.outputPath,
        coverageOutputPath: segment.coverageOutputPath,
        result,
        resultHash,
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
    const receipts: SegmentCoverageSidecar["receipts"] = [];
    for (const receipt of parsed.receipts) {
      if (!receipt || typeof receipt !== "object") return null;
      const record = receipt as Record<string, unknown>;
      const slotId = String(record.slotId || "");
      if (!knownSlots.has(slotId) || !Array.isArray(record.evidence)) return null;
      const slot = segment.segmentContract?.requiredEventSlots.find((item) => item.id === slotId);
      const evidence: Array<{ path: string; quote: string }> = [];
      for (const item of record.evidence.slice(0, slot?.importance === "blocking" ? 2 : 1)) {
        if (!item || typeof item !== "object") return null;
        const entry = item as Record<string, unknown>;
        const pathValue = String(entry.path || "").trim();
        const quote = String(entry.quote || "").trim();
        if (!pathValue || !quote || quote.length > 80 || !slot
          || !isCoverageEvidenceAllowed(result, slot.evidenceSelectors, pathValue, quote)) return null;
        evidence.push({ path: pathValue, quote });
      }
      if (!evidence.length) return null;
      receipts.push({ slotId, evidence });
    }
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

async function readStrictRenderResult(segment: VideoPromptPackSegmentTask) {
  const parsed = asRenderResultRecord(
    await readStrictFinalizationJson(path.dirname(segment.outputPath), path.basename(segment.outputPath)),
    segment.outputFileName,
  );
  try {
    await readVideoPromptOutputJson(segment.outputPath, `${segment.script}\n${segment.renderInputScript}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexJobFinalizationError(
      /encoding|question marks|replacement/i.test(message)
        ? "FINALIZATION_ENCODING_INVALID"
        : "FINALIZATION_SCHEMA_INVALID",
      message,
      { cause: error },
    );
  }
  return parsed;
}

function asRenderResultRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexJobFinalizationError(
      "FINALIZATION_SCHEMA_INVALID",
      `Render Pack output must contain one JSON object: ${label}`,
    );
  }
  return value as Record<string, unknown>;
}

function isCoverageEvidenceAllowed(
  result: Record<string, unknown>,
  selectors: NonNullable<SegmentContract["requiredEventSlots"]>[number]["evidenceSelectors"],
  evidencePath: string,
  quote: string,
) {
  const parsed = parseCoverageEvidencePath(evidencePath);
  if (!parsed) return false;
  const allowed = selectors.some((selector) => {
    if (parsed.source === "optimizedScript") return selector.source === "optimizedScript";
    return selector.source === "storyboard"
      && selector.fields.includes(parsed.field as SegmentEvidenceField)
      && (selector.shotNumber === undefined || selector.shotNumber === "any" || selector.shotNumber === parsed.shotNumber);
  });
  if (!allowed) return false;
  const value = readCoverageEvidenceValue(result, parsed);
  return typeof value === "string" && normalizeCoverageQuote(value).includes(normalizeCoverageQuote(quote));
}

function parseCoverageEvidencePath(value: string) {
  const evidencePath = String(value || "").trim();
  if (evidencePath === "optimizedScript") {
    return { source: "optimizedScript" as const, field: "optimizedScript", shotNumber: undefined, index: undefined };
  }
  const match = evidencePath.match(
    /^storyboard\[(\d+)]\.(visual|dialogue|shotPurpose|videoPrompt|firstFramePrompt|lastFramePrompt)$/,
  );
  if (!match) return null;
  const index = Number(match[1]);
  return {
    source: "storyboard" as const,
    field: match[2],
    shotNumber: index + 1,
    index,
  };
}

function readCoverageEvidenceValue(
  result: Record<string, unknown>,
  parsed: NonNullable<ReturnType<typeof parseCoverageEvidencePath>>,
) {
  if (parsed.source === "optimizedScript") return result.optimizedScript;
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  const shot = storyboard[parsed.index!] as Record<string, unknown> | undefined;
  return shot?.[parsed.field];
}

function normalizeCoverageQuote(value: string) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
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

async function validateRenderPackStaging(job: VideoPromptPackCodexJob, stabilityDelayMs?: number) {
  if (!job.stagingDir) {
    throw new VideoPromptPackCodexQueueError("Render Pack staging directory is missing", "FINALIZATION_OUTPUT_MISSING");
  }
  const expectedIndexes = requestedRenderPackIndexes(job);
  const segmentsDir = path.join(job.stagingDir, "segments");
  const coverageDir = path.join(job.stagingDir, "coverage");
  await validateExactRenderSegmentFiles(segmentsDir, expectedIndexes);
  await validateExactRenderCoverageFiles(coverageDir, expectedIndexes, job.coverageSidecarEnabled);

  const outputFiles: Array<{
    relativePath: string;
    kind: "render_result" | "coverage_sidecar";
  }> = [];
  const resultSegments: VideoPromptPackCodexResult["segments"] = [];
  for (const segment of job.segments) {
    const result = await readStrictRenderResult(segment);
    const resultHash = buildSegmentResultHash(result as AnalysisResult);
    const coverageSidecar = job.coverageSidecarEnabled === false
      ? null
      : await readOptionalCoverageSidecar(segment, result);
    const resultRelativePath = path.posix.join("segments", episodeFileName(segment.episodeIndex));
    outputFiles.push({ relativePath: resultRelativePath, kind: "render_result" });
    if (coverageSidecar) {
      outputFiles.push({
        relativePath: path.posix.join("coverage", coverageFileName(segment.episodeIndex)),
        kind: "coverage_sidecar",
      });
    } else {
      await rm(segment.coverageOutputPath, { force: true });
    }
    resultSegments.push({
      episodeIndex: segment.episodeIndex,
      outputPath: segment.outputPath,
      coverageOutputPath: segment.coverageOutputPath,
      result,
      resultHash,
      coverageSidecar,
    });
  }
  await assertFinalizationFilesStable({
    directory: job.stagingDir,
    relativePaths: outputFiles.map((output) => output.relativePath),
    delayMs: stabilityDelayMs,
  });
  return {
    outputFiles,
    result: {
      segments: resultSegments.sort((left, right) => left.episodeIndex - right.episodeIndex),
    } satisfies VideoPromptPackCodexResult,
  };
}

async function validateExactRenderSegmentFiles(segmentsDir: string, expectedIndexes: number[]) {
  let actualIndexes: number[];
  try {
    const entries = await readdir(segmentsDir, { withFileTypes: true });
    actualIndexes = entries
      .filter((entry) => entry.isFile() && /^episode-\d{3}\.json$/i.test(entry.name))
      .map((entry) => Number.parseInt(entry.name.slice(8, 11), 10))
      .sort((left, right) => left - right);
  } catch (error) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack segment output directory is missing",
      "PACK_FINALIZATION_MISSING_SEGMENT",
    );
  }
  const missing = expectedIndexes.filter((index) => !actualIndexes.includes(index));
  if (missing.length) {
    throw new VideoPromptPackCodexQueueError(
      `Render Pack is missing requested segments: ${missing.join(", ")}`,
      "PACK_FINALIZATION_MISSING_SEGMENT",
    );
  }
  const extra = actualIndexes.filter((index) => !expectedIndexes.includes(index));
  if (extra.length || actualIndexes.length !== expectedIndexes.length) {
    throw new VideoPromptPackCodexQueueError(
      `Render Pack contains unexpected segment identities: ${extra.join(", ") || "duplicate output"}`,
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
}

async function validateExactRenderCoverageFiles(
  coverageDir: string,
  expectedIndexes: number[],
  enabled: boolean,
) {
  if (!enabled) {
    await rm(coverageDir, { recursive: true, force: true });
    return;
  }
  const entries = await readdir(coverageDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const extraIndexes = entries
    .filter((entry) => entry.isFile() && /^episode-\d{3}\.coverage\.json$/i.test(entry.name))
    .map((entry) => Number.parseInt(entry.name.slice(8, 11), 10))
    .filter((index) => !expectedIndexes.includes(index));
  if (extraIndexes.length) {
    throw new VideoPromptPackCodexQueueError(
      `Render Pack coverage sidecars contain unexpected segments: ${extraIndexes.join(", ")}`,
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
}

function requestedRenderPackIndexes(job: VideoPromptPackCodexJob) {
  return job.segments.map((segment) => segment.episodeIndex).sort((left, right) => left - right);
}

function renderPackResultProjection(result: VideoPromptPackCodexResult) {
  return {
    segments: result.segments.map((segment) => ({
      episodeIndex: segment.episodeIndex,
      resultHash: segment.resultHash,
      result: segment.result,
      coverageSidecar: segment.coverageSidecar,
    })),
  };
}

function bindRenderPackJobToStaging(job: VideoPromptPackCodexJob, stagingDir: string): VideoPromptPackCodexJob {
  const template = job.outputTemplate || { segments: job.segments, prompt: job.prompt };
  const segmentsDir = path.join(stagingDir, "segments");
  const coverageDir = path.join(stagingDir, "coverage");
  const segments = template.segments.map((segment) => ({
    ...segment,
    outputPath: path.join(segmentsDir, episodeFileName(segment.episodeIndex)),
    coverageOutputPath: path.join(coverageDir, coverageFileName(segment.episodeIndex)),
  }));
  const replacements = template.segments.flatMap((segment, index) => [
    [segment.outputPath, segments[index].outputPath] as const,
    [segment.coverageOutputPath, segments[index].coverageOutputPath] as const,
  ]);
  const prompt = replacements.reduce(
    (value, [from, to]) => value.split(from).join(to),
    template.prompt,
  );
  return {
    ...job,
    outputTemplate: template,
    segments,
    prompt,
    stagingDir,
  };
}

function bindRenderPackJobToPublishedResult(job: VideoPromptPackCodexJob, publishedDir: string): VideoPromptPackCodexJob {
  const template = job.outputTemplate || { segments: job.segments, prompt: job.prompt };
  return {
    ...job,
    segments: template.segments.map((segment) => ({
      ...segment,
      outputPath: path.join(publishedDir, "segments", episodeFileName(segment.episodeIndex)),
      coverageOutputPath: path.join(publishedDir, "coverage", coverageFileName(segment.episodeIndex)),
    })),
  };
}

async function validatePublishedRenderPackJob(rootDir: string, job: VideoPromptPackCodexJob) {
  if (!job.resultRef || !job.contractHash) {
    throw new VideoPromptPackCodexQueueError(
      "Completed Render Pack is missing its immutable result reference",
      "FINALIZATION_OUTPUT_MISSING",
    );
  }
  const publishedDir = resolveRenderPackResultDirectory(rootDir, job.resultRef);
  const manifest = await readAndValidateFinalManifest({
    directory: publishedDir,
    expected: renderPackFinalizationIdentity(job, job.resultRef.resultHash),
  });
  const result = await readPackResult(bindRenderPackJobToPublishedResult(job, publishedDir), true);
  if (hashCanonicalJson(renderPackResultProjection(result)) !== manifest.resultHash) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack canonical result hash does not match its manifest",
      "FINALIZATION_HASH_MISMATCH",
    );
  }
  return { ...job, result, resultAvailable: true };
}

function renderPackFinalizationIdentity(job: VideoPromptPackCodexJob, resultHash: string) {
  return {
    jobId: job.id,
    taskClass: "render_pack" as const,
    leaseId: job.leaseId!,
    fencingToken: job.fencingToken,
    sourceHash: job.sourceHash,
    ...(job.contractHash ? { contractHash: job.contractHash } : {}),
    segmentIndexes: requestedRenderPackIndexes(job),
    resultHash,
  };
}

function resolveRenderPackResultDirectory(rootDir: string, resultRef: CodexFinalizedResultRef) {
  if (resultRef.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack result reference protocol is invalid",
      "FINALIZATION_SCHEMA_INVALID",
    );
  }
  const queueRoot = path.resolve(rootDir, TASK_ROOT);
  const immutableRoot = path.resolve(queueRoot, RESULT_DIR);
  const resultDir = path.resolve(queueRoot, ...String(resultRef.relativePath || "").split("/"));
  if (!resultDir.startsWith(`${immutableRoot}${path.sep}`)) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack result reference escapes its immutable result root",
      "FINALIZATION_SCHEMA_INVALID",
    );
  }
  return resultDir;
}

function sameResultRef(left: CodexFinalizedResultRef | null, right: CodexFinalizedResultRef | null) {
  return Boolean(left && right
    && left.protocolVersion === right.protocolVersion
    && left.resultHash === right.resultHash
    && left.relativePath === right.relativePath
    && left.manifestRelativePath === right.manifestRelativePath);
}

function mapRenderFinalizationError(error: CodexJobFinalizationError) {
  return new VideoPromptPackCodexQueueError(error.message, error.code);
}

function normalizeStoredRenderPackJob(job: VideoPromptPackCodexJob): VideoPromptPackCodexJob {
  const protocolVersion = job.protocolVersion === CODEX_FINALIZATION_PROTOCOL_VERSION ? 2 : 1;
  const status = job.status || "pending";
  return {
    ...job,
    protocolVersion,
    stage: job.stage || (status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "running"
          ? "executing"
          : "pending"),
    idempotencyKey: job.idempotencyKey || null,
    mode: job.mode === "standard" ? "standard" : "strictUtf8",
    outputTemplate: job.outputTemplate || null,
    leaseId: job.leaseId || null,
    workerId: job.workerId || null,
    attempt: Math.max(0, Number(job.attempt) || 0),
    fencingToken: Math.max(0, Number(job.fencingToken) || 0),
    stagingDir: job.stagingDir || null,
    sourceHash: job.sourceHash || hashCanonicalJson(job.segments.map((segment) => ({
      episodeIndex: segment.episodeIndex,
      title: segment.title,
      script: segment.script,
      renderInputScript: segment.renderInputScript,
      duration: segment.duration,
      shotCount: segment.shotCount || null,
    }))),
    contractHash: job.contractHash || (protocolVersion === 2
      ? hashCanonicalJson(job.segments.map((segment) => ({
          episodeIndex: segment.episodeIndex,
          contractHash: segment.segmentContract?.contractHash || null,
        })))
      : null),
    resultRef: job.resultRef || null,
    resultAvailable: protocolVersion === 1
      ? status === "completed" && Boolean(job.result)
      : Boolean(job.resultAvailable),
    errorCode: job.errorCode || null,
  };
}

export async function recoverFinalizedVideoPromptPackCodexJobs(rootDir: string, _runningTimeoutMs = 0) {
  const runningJobs = await listFileJobsByStatus<VideoPromptPackCodexJob>(rootDir, TASK_ROOT, "running");
  let recovered = 0;
  for (const stored of runningJobs) {
    const job = normalizeStoredRenderPackJob(stored);
    if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION
      || job.status !== "running"
      || job.stage !== "finalizing"
      || !job.leaseId) continue;
    try {
      const resultRef = job.resultRef || await recoverRenderPackResultReference(rootDir, job);
      if (!resultRef) continue;
      if (!job.resultRef || !sameResultRef(job.resultRef, resultRef)) {
        await updateRunningFileJob<VideoPromptPackCodexJob>(
          rootDir,
          TASK_ROOT,
          job.id,
          job.leaseId,
          job.fencingToken,
          { stage: "finalizing", resultRef, resultAvailable: false },
        );
      }
      await completeVideoPromptPackCodexJob(job.id, job.leaseId, job.fencingToken, resultRef, { rootDir });
      recovered += 1;
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code || "");
      if (code === "FINALIZATION_OUTPUT_MISSING" || code === "FINALIZATION_STALE_FENCE") continue;
      if (code === "FINALIZATION_ATOMIC_REPLACE_FAILED") throw error;
      await failVideoPromptPackCodexJob(
        job.id,
        job.leaseId,
        job.fencingToken,
        error instanceof Error ? error.message : "Render Pack finalization recovery failed",
        code || "FINALIZATION_SCHEMA_INVALID",
        { rootDir },
      ).catch((failure) => {
        if (String((failure as { code?: unknown } | null)?.code || "") !== "FINALIZATION_STALE_FENCE") throw failure;
      });
    }
  }
  return recovered;
}

async function recoverRenderPackResultReference(rootDir: string, job: VideoPromptPackCodexJob) {
  if (job.stagingDir) {
    try {
      const manifest = await validateRecoverableRenderPackDirectory(job, job.stagingDir);
      return publishFinalizedJob({
        ...renderPackRecoveryIdentity(rootDir, job, manifest.resultHash),
        stagingDir: job.stagingDir,
      });
    } catch (error) {
      if (String((error as { code?: unknown } | null)?.code || "") !== "FINALIZATION_OUTPUT_MISSING") throw error;
    }
  }

  const resultRoot = path.join(rootDir, TASK_ROOT, "results", job.id);
  const entries = await readdir(resultRoot, { withFileTypes: true, encoding: "utf8" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = path.join(resultRoot, entry.name);
    try {
      const manifest = await validateRecoverableRenderPackDirectory(job, directory);
      if (manifest.resultHash !== entry.name) {
        throw new VideoPromptPackCodexQueueError(
          "Render Pack immutable directory does not match its result hash",
          "FINALIZATION_HASH_MISMATCH",
        );
      }
      return buildFinalizedResultRef(job.id, manifest.resultHash);
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code || "");
      if (code === "FINALIZATION_STALE_FENCE" || code === "FINALIZATION_IDENTITY_MISMATCH") continue;
      throw error;
    }
  }
  return null;
}

async function validateRecoverableRenderPackDirectory(job: VideoPromptPackCodexJob, directory: string) {
  const expectedIndexes = requestedRenderPackIndexes(job);
  const manifest = await readAndValidateRecoverableFinalManifest({
    directory,
    expected: {
      jobId: job.id,
      taskClass: "render_pack",
      leaseId: job.leaseId!,
      fencingToken: job.fencingToken,
      sourceHash: job.sourceHash,
      ...(job.contractHash ? { contractHash: job.contractHash } : {}),
      segmentIndexes: expectedIndexes,
    },
  });
  const listedResultIndexes = manifest.outputFiles
    .filter((output) => output.kind === "render_result")
    .map((output) => parseEpisodeIndexFromFileName(path.posix.basename(output.relativePath)))
    .sort((left, right) => left - right);
  if (JSON.stringify(listedResultIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new VideoPromptPackCodexQueueError(
      "Render Pack manifest does not list exactly the requested segment results",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  await validateExactRenderSegmentFiles(path.join(directory, "segments"), expectedIndexes);
  await validateExactRenderCoverageFiles(
    path.join(directory, "coverage"),
    expectedIndexes,
    job.coverageSidecarEnabled,
  );
  const result = await readPackResult(bindRenderPackJobToPublishedResult(job, directory), true);
  if (hashCanonicalJson(renderPackResultProjection(result)) !== manifest.resultHash) {
    throw new VideoPromptPackCodexQueueError(
      "Recoverable Render Pack canonical result hash does not match its manifest",
      "FINALIZATION_HASH_MISMATCH",
    );
  }
  return manifest;
}

function renderPackRecoveryIdentity(rootDir: string, job: VideoPromptPackCodexJob, resultHash: string) {
  return {
    rootDir,
    namespace: TASK_ROOT,
    ...renderPackFinalizationIdentity(job, resultHash),
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

function parseEpisodeIndexFromFileName(fileName: string) {
  const match = /^episode-(\d{3})\.json$/i.exec(fileName);
  return match ? Number.parseInt(match[1], 10) : -1;
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
