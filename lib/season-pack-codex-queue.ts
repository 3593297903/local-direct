import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSegmentContractHash,
  normalizeSegmentContract,
  validateSegmentContract,
  type SegmentContract,
} from "./batch-segment-contract";
import {
  assertCleanCodexPromptInput,
  buildChinesePromptLexiconBlock,
  compileCodexPromptText,
  segmentContractToChineseRenderBlock,
} from "./codex-prompt-input-compiler";
import { findInternalPromptToken, sanitizeInternalPromptTokens } from "./internal-prompt-token-sanitizer";
import {
  createBatchEventFeatureSnapshot,
  normalizeBatchEventFeatureSnapshot,
  type BatchEventFeatureSnapshot,
} from "./batch-event-feature-flags";
import { applyPromptSafetyPolicyDeep, type PromptSafetyDiff } from "./prompt-safety-policy";
import { readCodexRuntimeHealth } from "./codex-runtime-health";
import {
  buildFinalizedResultRef,
  CODEX_FINALIZATION_PROTOCOL_VERSION,
  type CodexFinalizedResultRef,
  CodexJobFinalizationError,
  assertFinalizationFilesStable,
  createJobStagingDirectory,
  hashCanonicalJson,
  publishFinalizedJob,
  readAndValidateFinalManifest,
  readAndValidateRecoverableFinalManifest,
  readStrictFinalizationJson,
  writeFinalManifest,
} from "./codex-job-finalization";
import {
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

export type SeasonPackCodexJobStatus = "pending" | "running" | "completed" | "failed";
export type SeasonPackSegmentCountMode = "fixed" | "auto";
export type SeasonPackCodexJobStage =
  | "pending"
  | "claimed"
  | "waiting_slot"
  | "executing"
  | "finalizing"
  | "completed"
  | "failed";

export type CreateSeasonPackCodexJobInput = {
  projectId?: string;
  script: string;
  episodeCount?: number;
  segmentCountMode?: SeasonPackSegmentCountMode;
  duration?: string;
  contentType?: string;
  style?: string;
  projectMemory?: string;
};

export type SeasonPackEpisodeResult = {
  episodeIndex: number;
  fileName: string;
  input: SeasonPackEpisodeInput;
};

export type SeasonPackEpisodeInput = {
  episodeIndex: number;
  title: string;
  sourceText: string;
  duration: string;
  contentType: string;
  style: string;
  storyBible: unknown;
  episodeChain: unknown;
  blueprint: unknown;
  shotCount: number;
  renderInputScript: string;
  beatIds?: string[];
  beatRange?: {
    start: number;
    end: number;
  };
  targetDurationSeconds?: number;
  lockedSegmentPlan?: LockedSeasonSegment;
  segmentContract?: SegmentContract;
};

export type SeasonPackBeat = {
  id: string;
  summary: string;
  sourceText: string;
  estimatedDurationSeconds: number;
  shotCount: number;
};

export type LockedSeasonSegment = {
  segmentIndex: number;
  title: string;
  beatStart: number;
  beatEnd: number;
  beatIds: string[];
  estimatedDurationSeconds: number;
  shotCount: number;
  sourceText: string;
};

export type SeasonPackCodexJobResult = {
  manifest: Record<string, unknown> | null;
  seasonPlan: Record<string, unknown> | null;
  episodes: SeasonPackEpisodeResult[];
};

export type SeasonPackCodexJob = {
  id: string;
  protocolVersion: 1 | 2;
  stage: SeasonPackCodexJobStage;
  projectId: string | null;
  script: string;
  segmentCountMode: SeasonPackSegmentCountMode;
  requestedEpisodeCount: number | null;
  resolvedEpisodeCount: number | null;
  episodeCount: number;
  duration: string;
  contentType: string;
  style: string;
  projectMemory: string;
  featureFlags: BatchEventFeatureSnapshot;
  safetyDiffs: PromptSafetyDiff[];
  prompt: string;
  outputTemplate: {
    packDir: string;
    episodesDir: string;
    manifestPath: string;
    seasonPlanPath: string;
    prompt: string;
  } | null;
  status: SeasonPackCodexJobStatus;
  leaseId: string | null;
  workerId: string | null;
  heartbeatAt?: string;
  claimedAt?: string;
  waitingSlotAt?: string;
  executingAt?: string;
  finalizingAt?: string;
  attempt: number;
  fencingToken: number;
  packDir: string;
  episodesDir: string;
  manifestPath: string;
  seasonPlanPath: string;
  stagingDir: string | null;
  sourceHash: string;
  contractHash: string | null;
  resultRef: CodexFinalizedResultRef | null;
  resultAvailable: boolean;
  result: SeasonPackCodexJobResult | null;
  error: string | null;
  errorCode?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

type QueueOptions = {
  rootDir?: string;
};

type ClaimOptions = QueueOptions & {
  order?: "oldest" | "newest";
  runningTimeoutMs?: number;
  workerId?: string;
};

type SeasonSourceSegment = {
  episodeIndex: number;
  title: string;
  shotCount: number;
  duration?: string;
};

type SeasonSourceContext = {
  contentType?: string;
  style?: string;
  segments: Map<number, SeasonSourceSegment>;
};

type OutputJsonContext = {
  sourceText: string;
  episodeIndex: number;
  episodeCount: number;
  duration: string;
  contentType: string;
  style: string;
  sourceContext: SeasonSourceContext;
  lockedSegment?: LockedSeasonSegment;
  segmentContract?: SegmentContract;
};

const TASK_ROOT = ".tmp-season-pack-codex";
const JOB_DIR = "jobs";
const PACK_DIR = "packs";
const MAX_EPISODE_COUNT = 30;
const MAX_SCRIPT_LENGTH = 50_000;
const REQUIRED_EPISODE_INPUT_FIELDS = ["title", "sourceText", "duration", "contentType", "style", "renderInputScript"];
const REQUIRED_STORYBOARD_SHOT_FIELDS = [
  "shotNumber",
  "timeRange",
  "scene",
  "visual",
  "shotType",
  "composition",
  "cameraMovement",
  "lighting",
  "sound",
  "dialogue",
  "emotion",
  "transition",
  "shotPurpose",
  "firstFramePrompt",
  "videoPrompt",
  "lastFramePrompt",
  "negativePrompt",
];
const REQUIRED_ANALYSIS_RESULT_FIELDS = ["title", "duration", "contentType", "style"];
const GENERIC_TEMPLATE_PHRASES = [
  "人物、地点和关键物件按案件逻辑分层",
  "缓慢推进后停住",
  "同期环境声、脚步声、纸张声或市场声",
  "保留北方县城真实空间感",
];

export class SeasonPackCodexQueueError extends Error {
  readonly code: string;

  constructor(message: string, code = "SEASON_PACK_JOB_INVALID") {
    super(message);
    this.name = "SeasonPackCodexQueueError";
    this.code = code;
  }
}

export async function createSeasonPackCodexJob(
  input: CreateSeasonPackCodexJobInput,
  options: QueueOptions = {},
) {
  validateCreateInput(input);

  const rootDir = resolveRootDir(options);
  const now = new Date().toISOString();
  const jobId = createId("season-pack-job");
  const packDir = path.join(packRootDir(rootDir), jobId);
  const episodesDir = path.join(packDir, "episodes");
  const manifestPath = path.join(packDir, "manifest.json");
  const seasonPlanPath = path.join(packDir, "season-plan.json");
  const duration = normalizeRequestedDuration(input.duration);
  const contentType = input.contentType || "短剧 / 通用";
  const style = input.style || "自动匹配文案气质";
  const projectMemory = input.projectMemory || "";
  const segmentCountMode: SeasonPackSegmentCountMode = input.segmentCountMode === "auto" ? "auto" : "fixed";
  const requestedEpisodeCount = segmentCountMode === "auto" ? null : input.episodeCount || 1;
  const episodeCount = requestedEpisodeCount || 0;
  const featureFlags = createBatchEventFeatureSnapshot(process.env, now);
  const modelPrepass = applyPromptSafetyPolicyDeep({
    ...input,
    duration,
    contentType,
    style,
    projectMemory,
    segmentCountMode,
    episodeCount,
  }, { phase: "planning" });
  const prompt = buildSeasonPackCodexPrompt(
    modelPrepass.sourceTextForModel,
    { packDir, episodesDir, manifestPath, seasonPlanPath },
    featureFlags,
  );
  assertCleanCodexPromptInput(prompt, "Season pack planning prompt");
  const job: SeasonPackCodexJob = {
    id: jobId,
    protocolVersion: CODEX_FINALIZATION_PROTOCOL_VERSION,
    stage: "pending",
    projectId: input.projectId || null,
    script: input.script,
    segmentCountMode,
    requestedEpisodeCount,
    resolvedEpisodeCount: null,
    episodeCount,
    duration,
    contentType,
    style,
    projectMemory,
    featureFlags,
    safetyDiffs: modelPrepass.safetyDiffs,
    prompt,
    outputTemplate: { packDir, episodesDir, manifestPath, seasonPlanPath, prompt },
    status: "pending",
    leaseId: null,
    workerId: null,
    attempt: 0,
    fencingToken: 0,
    packDir,
    episodesDir,
    manifestPath,
    seasonPlanPath,
    stagingDir: null,
    sourceHash: createHash("sha256").update(input.script, "utf8").digest("hex"),
    contractHash: null,
    resultRef: null,
    resultAvailable: false,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await ensureFileJobStore(rootDir, TASK_ROOT);
  await ensureQueueDirs(rootDir);
  return putPendingFileJob(rootDir, TASK_ROOT, job);
}

export async function getSeasonPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  try {
    const job = normalizeStoredSeasonPackJob(await getFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, jobId));
    if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) return readLegacySeasonPackJob(rootDir, jobId);
    if (job.status !== "completed") {
      return { ...job, result: null, resultAvailable: false };
    }
    return validatePublishedSeasonPackJob(rootDir, job);
  } catch (error) {
    if (error instanceof CodexJobFinalizationError) throw mapSeasonFinalizationError(error);
    if ((error as { code?: unknown } | null)?.code === "JOB_STORAGE_BUSY") {
      throw new SeasonPackCodexQueueError("Season Pack queue storage is temporarily busy", "JOB_STORAGE_BUSY");
    }
    if (error instanceof Error && error.message !== "File job not found") throw error;
    return readLegacySeasonPackJob(rootDir, jobId);
  }
}

export async function claimNextSeasonPackCodexJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  await ensureFileJobStore(rootDir, TASK_ROOT);
  await recoverFinalizedSeasonPackCodexJobs(rootDir);
  const claimed = await claimNextFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, {
    order: options.order,
    runningTimeoutMs: options.runningTimeoutMs,
    workerId: options.workerId,
    canRecoverRunningJob: (job) => canRecoverSeasonPackJob(rootDir, job),
    canClaimPendingJob: (job) => normalizeStoredSeasonPackJob(job).protocolVersion === CODEX_FINALIZATION_PROTOCOL_VERSION,
  });
  if (!claimed) return null;
  const normalized = normalizeStoredSeasonPackJob(claimed);
  if (normalized.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) {
    throw new SeasonPackCodexQueueError("Protocol v2 worker cannot claim a legacy Season Pack job", "FINALIZATION_IDENTITY_MISMATCH");
  }
  const stagingDir = await createJobStagingDirectory({
    rootDir,
    namespace: TASK_ROOT,
    jobId: normalized.id,
    leaseId: normalized.leaseId!,
    fencingToken: normalized.fencingToken,
  });
  const staged = bindSeasonPackJobToStaging(normalized, stagingDir);
  return updateRunningFileJob(rootDir, TASK_ROOT, normalized.id, normalized.leaseId!, normalized.fencingToken, {
    ...staged,
    stage: "claimed",
    claimedAt: normalized.claimedAt || normalized.startedAt || new Date().toISOString(),
    error: null,
    errorCode: null,
  });
}

export async function updateSeasonPackCodexJobStage(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  stage: Extract<SeasonPackCodexJobStage, "waiting_slot" | "executing" | "finalizing">,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const allowedPrevious: Record<typeof stage, SeasonPackCodexJobStage[]> = {
    waiting_slot: ["claimed", "waiting_slot"],
    executing: ["claimed", "waiting_slot", "executing"],
    finalizing: ["executing", "finalizing"],
  };
  return updateRunningFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, jobId, leaseId, fencingToken, (current) => {
    const normalized = normalizeStoredSeasonPackJob(current);
    if (!allowedPrevious[stage].includes(normalized.stage)) {
      throw new SeasonPackCodexQueueError(`Season Pack cannot transition from ${normalized.stage} to ${stage}`, "FINALIZATION_IDENTITY_MISMATCH");
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

export async function finalizeSeasonPackCodexJobFiles(
  task: SeasonPackCodexJob,
  options: QueueOptions & { codexExitCode: number; stabilityDelayMs?: number },
) {
  const rootDir = resolveRootDir(options);
  if (!task.leaseId || !task.stagingDir) {
    throw new SeasonPackCodexQueueError("Season Pack finalization requires an active staging lease", "FINALIZATION_STALE_FENCE");
  }
  const { job: stored } = await readRunningFileJob<SeasonPackCodexJob>(
    rootDir,
    TASK_ROOT,
    task.id,
    task.leaseId,
    task.fencingToken,
  );
  const job = normalizeStoredSeasonPackJob(stored);
  if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION || job.stagingDir !== task.stagingDir) {
    throw new SeasonPackCodexQueueError("Season Pack staging identity does not match the active lease", "FINALIZATION_IDENTITY_MISMATCH");
  }
  if (job.stage !== "finalizing") {
    throw new SeasonPackCodexQueueError("Season Pack must enter finalizing before publication", "FINALIZATION_IDENTITY_MISMATCH");
  }
  if (options.codexExitCode !== 0) {
    throw new SeasonPackCodexQueueError(`Codex process exited with code ${options.codexExitCode}`, "CODEX_PROCESS_FAILED");
  }
  const modelManifest = asJsonRecord(await readStrictFinalizationJson(job.stagingDir, "manifest.json"), "manifest.json");
  const modelSeasonPlan = asJsonRecord(await readStrictFinalizationJson(job.stagingDir, "season-plan.json"), "season-plan.json");
  validateEncodingQuality(modelManifest, job.script);
  validateEncodingQuality(modelSeasonPlan, job.script);
  const lockedSeasonPlan = buildLockedSeasonPlan(modelSeasonPlan, job.featureFlags.coveragePolicyVersion);
  const expectedEpisodeCount = resolveSeasonPackEpisodeCount(job, modelManifest, lockedSeasonPlan.segments.length);
  validateSeasonModelManifest(job, modelManifest, expectedEpisodeCount);
  validateLockedSeasonPlanCount(lockedSeasonPlan.segments, expectedEpisodeCount);
  const expectedIndexes = Array.from({ length: expectedEpisodeCount }, (_, index) => index + 1);
  await validateExactSeasonEpisodeFiles(job.episodesDir, expectedIndexes);
  const outputFiles = [
    { relativePath: "manifest.json", kind: "season_plan" as const },
    { relativePath: "season-plan.json", kind: "season_plan" as const },
    ...expectedIndexes.map((episodeIndex) => ({
      relativePath: path.posix.join("episodes", episodeFileName(episodeIndex)),
      kind: "episode_input" as const,
    })),
  ];
  for (const output of outputFiles) {
    const parsed = asJsonRecord(await readStrictFinalizationJson(job.stagingDir, output.relativePath), output.relativePath);
    validateEncodingQuality(parsed, job.script);
  }
  await assertFinalizationFilesStable({
    directory: job.stagingDir,
    relativePaths: outputFiles.map((output) => output.relativePath),
    delayMs: options.stabilityDelayMs,
  });
  const result = await readSeasonPackResult(job);
  const segmentIndexes = result.episodes.map((episode) => episode.episodeIndex);
  const contractHash = seasonResultContractHash(result);
  const resultHash = hashCanonicalJson(result);
  const identity = {
    rootDir,
    namespace: TASK_ROOT,
    jobId: job.id,
    taskClass: "season_pack" as const,
    leaseId: job.leaseId!,
    fencingToken: job.fencingToken,
    sourceHash: job.sourceHash,
    contractHash,
    segmentIndexes,
    resultHash,
  };
  await writeFinalManifest({
    ...identity,
    stagingDir: job.stagingDir,
    codexExitCode: options.codexExitCode,
    outputFiles,
  });
  const resultRef = await publishFinalizedJob({ ...identity, stagingDir: job.stagingDir });
  await updateRunningFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, job.id, job.leaseId!, job.fencingToken, {
    stage: "finalizing",
    episodeCount: job.segmentCountMode === "auto" ? segmentIndexes.length : job.episodeCount,
    resolvedEpisodeCount: segmentIndexes.length,
    contractHash,
    resultRef,
    resultAvailable: false,
  });
  return { resultRef, resultHash, contractHash, segmentIndexes };
}

export async function completeSeasonPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  resultRef: CodexFinalizedResultRef,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = normalizeStoredSeasonPackJob(await getFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, jobId));
  assertSeasonPackLease(job, leaseId, fencingToken);
  if (job.status === "completed") {
    if (!sameResultRef(job.resultRef, resultRef)) {
      throw new SeasonPackCodexQueueError("Completed Season Pack result reference does not match", "FINALIZATION_IDENTITY_MISMATCH");
    }
    return validatePublishedSeasonPackJob(rootDir, job);
  }
  if (job.status !== "running" || job.stage !== "finalizing" || !sameResultRef(job.resultRef, resultRef)) {
    throw new SeasonPackCodexQueueError("Season Pack has not been finalized by the active worker", "FINALIZATION_OUTPUT_MISSING");
  }
  const resultDir = resolveSeasonResultDirectory(rootDir, resultRef);
  const manifest = await readAndValidateFinalManifest({
    directory: resultDir,
    expected: seasonFinalizationIdentity(job, resultRef.resultHash),
  });
  const result = await readSeasonPackResult(bindSeasonPackJobToPublishedResult(job, resultDir));
  if (hashCanonicalJson(result) !== manifest.resultHash) {
    throw new SeasonPackCodexQueueError("Season Pack canonical result hash does not match its manifest", "FINALIZATION_HASH_MISMATCH");
  }
  const now = new Date().toISOString();
  const resolvedEpisodeCount = result.episodes.length;
  const updated: SeasonPackCodexJob = {
    ...job,
    episodeCount: job.segmentCountMode === "auto" ? resolvedEpisodeCount : job.episodeCount,
    resolvedEpisodeCount,
    status: "completed",
    stage: "completed",
    contractHash: manifest.contractHash || null,
    resultRef,
    resultAvailable: true,
    result: null,
    error: null,
    completedAt: now,
    updatedAt: now,
  };
  const persisted = await finishRunningFileJob(rootDir, TASK_ROOT, updated, "completed");
  return { ...persisted, result };
}

export async function failSeasonPackCodexJob(
  jobId: string,
  leaseId: string,
  fencingToken: number,
  message: string | undefined,
  errorCode: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = normalizeStoredSeasonPackJob(await getFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, jobId));
  assertSeasonPackLease(job, leaseId, fencingToken);
  if (job.status === "failed") return job;
  if (job.status !== "running") {
    throw new SeasonPackCodexQueueError("Completed Season Pack cannot be failed", "JOB_ALREADY_COMPLETED");
  }
  if (job.stage === "finalizing" && job.resultRef) {
    try {
      await validatePublishedSeasonPackJob(rootDir, job);
      return job;
    } catch {
      // Only a fully validated immutable publication is protected from failure.
    }
  }
  const updated: SeasonPackCodexJob = {
    ...job,
    status: "failed",
    stage: "failed",
    resultAvailable: false,
    result: null,
    error: message || "Codex season pack generation failed",
    errorCode: errorCode || null,
    updatedAt: new Date().toISOString(),
  };
  return finishRunningFileJob(rootDir, TASK_ROOT, updated, "failed");
}

export async function failPendingSeasonPackCodexJob(
  jobId: string,
  message: string | undefined,
  errorCode: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = normalizeStoredSeasonPackJob(await getFileJob<SeasonPackCodexJob>(rootDir, TASK_ROOT, jobId));
  if (job.status === "failed") return job;
  if (job.status !== "pending") return job;
  const updated: SeasonPackCodexJob = {
    ...job,
    status: "failed",
    stage: "failed",
    resultAvailable: false,
    result: null,
    error: message || "Codex season pack generation is unavailable",
    errorCode: errorCode || null,
    updatedAt: new Date().toISOString(),
  };
  return finishPendingFileJob(rootDir, TASK_ROOT, updated, "failed");
}

export function toSeasonPackCodexJobStatusDto(job: SeasonPackCodexJob) {
  return {
    id: job.id,
    protocolVersion: job.protocolVersion,
    status: job.status,
    stage: job.stage,
    segmentCountMode: job.segmentCountMode,
    requestedEpisodeCount: job.requestedEpisodeCount,
    resolvedEpisodeCount: job.resolvedEpisodeCount,
    episodeCount: job.episodeCount,
    featureFlags: job.featureFlags,
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
    resultAvailable: job.protocolVersion === 1 ? job.status === "completed" && Boolean(job.result) : job.resultAvailable,
    ...(job.resultRef?.resultHash ? { resultHash: job.resultRef.resultHash } : {}),
    ...(job.status === "completed" && job.resultAvailable ? { result: job.result } : {}),
  };
}

function buildSeasonPackCodexPrompt(
  input: {
    projectId?: string;
    script: string;
    episodeCount: number;
    segmentCountMode: SeasonPackSegmentCountMode;
    duration: string;
    contentType: string;
    style: string;
    projectMemory: string;
  },
  paths: { packDir: string; episodesDir: string; manifestPath: string; seasonPlanPath: string },
  featureFlags: BatchEventFeatureSnapshot,
) {
  const isAuto = input.segmentCountMode === "auto";
  const exampleLast = episodeFileName(isAuto ? MAX_EPISODE_COUNT : input.episodeCount);
  const script = compileCodexPromptText(input.script);
  const contentType = compileCodexPromptText(input.contentType);
  const style = compileCodexPromptText(input.style);
  const projectMemory = compileCodexPromptText(input.projectMemory || "(none)");
  const lexiconBlock = buildChinesePromptLexiconBlock([
    input.script,
    input.contentType,
    input.style,
    input.projectMemory,
  ]);
  const segmentCountInstruction = isAuto
    ? "You must decide the best segment count between 1 and 30 from the source structure. Every resolved segment must be 15 seconds or less unless the source explicitly asks for a shorter duration."
    : `You must write exactly ${input.episodeCount} segment JSON files.`;
  const filePatternInstruction = isAuto
    ? `Segment files keep the compatibility filename pattern episode-001.json through the resolved final file, never beyond ${exampleLast}.`
    : `Segment files keep the compatibility filename pattern episode-001.json through ${exampleLast}.`;
  const requiredEpisodeFilesInstruction = isAuto
    ? "- 在分段目录中为每一个识别出的段落写一个段落输入文件。识别段数必须是 1-30，并且必须和 manifest.generatedEpisodes 一致。"
    : `- 在分段目录中写 ${input.episodeCount} 个段落输入文件。`;
  const contractRules = featureFlags.contractV2
    ? [
        "- 包含第二版段落生成契约：每个锁定段落对应一份契约，机器字段包括 contractSchemaVersion=2, coveragePolicyVersion, segmentIndex, title, sourceText, durationSeconds, shotCount, requiredEvents, requiredEventSlots, forbiddenFutureEvents, characterLocks, characters, locations, props, requiredShotBeats, safetyPolicy。",
        "- requiredEvents 只用于帮助模型理解，不得作为逐字硬匹配依据。真正阻断级事件必须写入 requiredEventSlots。",
        "- requiredEventSlots 每项必须包含 id, label, importance, anchorGroups, conceptGroups, contradictionGroups, evidenceSelectors, repairTargets。blocking 槽必须完整；不完整或不确定的槽写为 advisory。",
        "- evidenceSelectors 只能引用 optimizedScript 或 storyboard 的 visual/dialogue/shotPurpose/videoPrompt/firstFramePrompt/lastFramePrompt。",
        "- repairTargets 只能引用 storyboard 叶子字段，使用 shotNumber 数字或 best_match；禁止把 workflow.fullVideoPrompt、workflow.filmScript 或 workflow.concisePrompt 作为修复目标。",
        "- 人物身份、关系、服装、伤势和道具归属等不变事实写入 characterLocks 或相应连续性锁，mode 使用 must_not_contradict；不要把仅需保持不变的事实写成 requiredEventSlot。",
        "- 只有本段必须主动展示某个身份或关系时，才为它额外创建 requiredEventSlot。最终生成段落不得出现 forbiddenFutureEvents。",
      ]
    : ["- 当前批次未启用第二版事件覆盖契约，只需按锁定剧情节拍和镜头数量生成稳定分段规划。"];
  return [
    "你正在通过本地 Codex CLI worker 执行 Local Director 多段规划任务。",
    "请用一次长上下文阅读完整原文，并生成规划文件包。",
    "重要：这里不要生成最终视频提示词，也不要生成最终视频提示词结果 JSON。",
    "本任务只创建项目固定记忆、段落承接关系，以及给后续中文单段渲染器使用的段落输入包。",
    "不要调用网络模型，不要打开浏览器，不要向用户追问。",
    "",
    segmentCountInstruction,
    filePatternInstruction,
    "每个文件必须包含一个严格的段落输入包 JSON 对象，不是最终提示词结果。",
    "旧代码中这个对象可能仍叫 Episode Input Pack，但所有用户可见文本必须使用“段”。",
    "每个段落输入包必须包含这些机器字段：episodeIndex, title, sourceText, duration, contentType, style, storyBible, episodeChain, blueprint, shotCount, renderInputScript。",
    "不要包含 workflow.fullVideoPrompt，不要包含 storyboard；后续单段渲染器会生成这些内容。",
    "",
    "Write these files as UTF-8 with Node.js fs.writeFileSync. Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    `Pack directory: ${paths.packDir}`,
    `Manifest path: ${paths.manifestPath}`,
    `Season plan path: ${paths.seasonPlanPath}`,
    `Episodes directory: ${paths.episodesDir}`,
    "",
    "必须写出的文件包：",
    "- manifest.json with episodeCount, generatedEpisodes, and status.",
    "- season-plan.json with storyBible, episodeChain, characters, scenes, props, visualStyle, cameraLanguage, lockedRules, beats, lockedSegments, and segmentContracts.",
    requiredEpisodeFilesInstruction,
    "",
    "规划规则：",
    "- 从完整原文和项目记忆中建立一份稳定的项目固定记忆。",
    "- 先提取全局有序剧情节拍数组。每个节拍必须包含机器字段 id, summary, sourceText, estimatedDurationSeconds, shotCount。",
    "- 以节拍作为分段事实来源。程序会在渲染前把节拍重新装入不超过 15 秒的锁定段落。",
    "- 不要让后续渲染 worker 决定某个镜头是否挪到下一段；所有移动和拆分都必须在规划阶段完成。",
    "- 如果某个节拍本身超过 15 秒，先把它拆成更小的节拍，再写入 season-plan.json。",
    "- 尽量包含 segments 或 lockedSegments 数组，字段包括 segmentIndex, title, beatStart, beatEnd, beatIds, estimatedDurationSeconds, shotCount, sourceText。",
    ...contractRules,
    "- 每段必须 <=15 秒。理想段长是 9-14.8 秒。低于 7 秒的段落除非是刻意钩子，否则应优先和相邻段合并。",
    "- 为所有请求段落建立段落承接关系，字段包括 startState, endState, carriedHooks, resolvedHooks, nextBridge, timelinePosition。",
    "- 所有段落必须和同一份项目固定记忆、角色称呼、地点称呼和道具称呼保持一致。",
    "- 如果提供了项目记忆，要从现有记忆继续，不要重置已有角色、设定或语气。",
    "- 如果项目记忆为空，要从完整原文中推断新的项目固定记忆。",
    isAuto
      ? "- 自动模式：按剧情含义和顺序把原文拆成最合适数量的 Local Director 视频段。段数要足够保留具体事件，但每段必须聚焦且 <=15 秒。"
      : "- 按用户请求数量和剧情顺序拆成视频段。这些是 Local Director 段落，不是故事剧集。",
    "- If the source script already contains explicit segment headings such as 第1段 / 第2段, preserve that segment count and order.",
    "- If the source contains labels such as 原剧本第二集 / 第三集, keep them only as internal source metadata and never write them into final title, sourceText, or renderInputScript.",
    "- If a source segment contains explicit 镜头 lines or time-range shot lines such as 0s-4s｜镜头1 or 00:00-00:04｜镜头1, use that count only when it fits the duration density rules below.",
    "- 镜头密度锁定：15 秒默认 4-5 镜头；10-20 秒的 shotCount 必须是 4 或 5，除非用户明确写了密集镜头版。不要把 7-8 个镜头塞进 14-15 秒段落。",
    "- 如果原文没有明确镜头行，按时长推断 shotCount：<=8 秒需要 2 个镜头，10-20 秒需要 4-5 个镜头，20-60 秒需要 5-8 个镜头，更长内容必须拆成更多具体节拍。",
    "- 在 sourceText 和 blueprint 中保留原文的具体地点、动作、物件、台词和人物节拍。",
    "- 如果原文有段落标题，段落标题应写成“第N段｜原文段落标题”。",
    "- 如果原文有明确镜头时间范围，段落时长应匹配原文段落结束时间；否则按用户请求时长执行。",
    "- contentType 和 style 必须是从完整原文和项目记忆推断出的具体中文文本，不能留空。",
    "- renderInputScript 是要发给后续中文单段渲染器的准确输入，必须短而完整。",
    "- renderInputScript 必须包含：项目固定记忆摘要、段落承接关系、本段结构规划、中文段落契约摘要、原文范围、镜头数量锁、风格锁定、连续性规则，以及生成完整 Local Director 中文段落视频提示词结果的明确要求。",
    "- renderInputScript 必须写“第 N 段”“本段”“单段渲染输入”，不得写“第 N 集”“本集”或“单集”。",
    "- renderInputScript 不得包含最终 workflow.fullVideoPrompt 或最终 storyboard JSON。",
    "",
    `Project ID: ${input.projectId || "new project"}`,
    `Segment count mode: ${input.segmentCountMode}`,
    `Segment count: ${isAuto ? "auto" : input.episodeCount}`,
    `Duration: ${input.duration}`,
    `Content type: ${contentType}`,
    `Style: ${style}`,
    "",
    lexiconBlock,
    lexiconBlock ? "" : "",
    "Project memory:",
    projectMemory,
    "",
    "Full source script:",
    script,
    "",
    "Completion requirements:",
    "1. Create all directories if they do not exist.",
    "2. Write manifest.json, season-plan.json, and every episode input-pack JSON file.",
    "3. Read every JSON file back and confirm it parses.",
    "4. Confirm Chinese characters are preserved, not replaced by question marks.",
    "5. Final reply must be exactly one line: DONE.",
  ].join("\n");
}

function normalizeStoredSeasonPackJob(job: SeasonPackCodexJob): SeasonPackCodexJob {
  const protocolVersion = job.protocolVersion === CODEX_FINALIZATION_PROTOCOL_VERSION ? 2 : 1;
  const status = job.status || "pending";
  return {
    ...job,
    protocolVersion,
    stage: job.stage || (status === "completed" ? "completed" : status === "failed" ? "failed" : status === "running" ? "executing" : "pending"),
    featureFlags: normalizeBatchEventFeatureSnapshot(job.featureFlags, job.createdAt),
    safetyDiffs: Array.isArray(job.safetyDiffs) ? job.safetyDiffs : [],
    outputTemplate: job.outputTemplate || null,
    leaseId: job.leaseId || null,
    workerId: job.workerId || null,
    attempt: Math.max(0, Number(job.attempt) || 0),
    fencingToken: Math.max(0, Number(job.fencingToken) || 0),
    stagingDir: job.stagingDir || null,
    sourceHash: job.sourceHash || createHash("sha256").update(job.script || "", "utf8").digest("hex"),
    contractHash: job.contractHash || null,
    resultRef: job.resultRef || null,
    resultAvailable: protocolVersion === 1 ? status === "completed" && Boolean(job.result) : Boolean(job.resultAvailable),
  };
}

function bindSeasonPackJobToStaging(job: SeasonPackCodexJob, stagingDir: string): SeasonPackCodexJob {
  const template = job.outputTemplate || {
    packDir: job.packDir,
    episodesDir: job.episodesDir,
    manifestPath: job.manifestPath,
    seasonPlanPath: job.seasonPlanPath,
    prompt: job.prompt,
  };
  const packDir = stagingDir;
  const episodesDir = path.join(stagingDir, "episodes");
  const manifestPath = path.join(stagingDir, "manifest.json");
  const seasonPlanPath = path.join(stagingDir, "season-plan.json");
  const replacements = [
    [template.episodesDir, episodesDir],
    [template.manifestPath, manifestPath],
    [template.seasonPlanPath, seasonPlanPath],
    [template.packDir, packDir],
  ] as const;
  const prompt = replacements.reduce(
    (value, [from, to]) => value.split(from).join(to),
    template.prompt,
  );
  return {
    ...job,
    outputTemplate: template,
    packDir,
    episodesDir,
    manifestPath,
    seasonPlanPath,
    stagingDir,
    prompt,
  };
}

function bindSeasonPackJobToPublishedResult(job: SeasonPackCodexJob, resultDir: string): SeasonPackCodexJob {
  return {
    ...job,
    packDir: resultDir,
    episodesDir: path.join(resultDir, "episodes"),
    manifestPath: path.join(resultDir, "manifest.json"),
    seasonPlanPath: path.join(resultDir, "season-plan.json"),
  };
}

async function validatePublishedSeasonPackJob(rootDir: string, job: SeasonPackCodexJob) {
  if (!job.resultRef || !job.contractHash) {
    throw new SeasonPackCodexQueueError("Completed Season Pack is missing its immutable result reference", "FINALIZATION_OUTPUT_MISSING");
  }
  const resultDir = resolveSeasonResultDirectory(rootDir, job.resultRef);
  const manifest = await readAndValidateFinalManifest({
    directory: resultDir,
    expected: seasonFinalizationIdentity(job, job.resultRef.resultHash),
  });
  const result = await readSeasonPackResult(bindSeasonPackJobToPublishedResult(job, resultDir));
  if (hashCanonicalJson(result) !== manifest.resultHash) {
    throw new SeasonPackCodexQueueError("Season Pack canonical result hash does not match its manifest", "FINALIZATION_HASH_MISMATCH");
  }
  return { ...job, result, resultAvailable: true };
}

function seasonFinalizationIdentity(job: SeasonPackCodexJob, resultHash: string) {
  return {
    jobId: job.id,
    taskClass: "season_pack" as const,
    leaseId: job.leaseId!,
    fencingToken: job.fencingToken,
    sourceHash: job.sourceHash,
    ...(job.contractHash ? { contractHash: job.contractHash } : {}),
    segmentIndexes: seasonSegmentIndexes(job),
    resultHash,
  };
}

function seasonSegmentIndexes(job: SeasonPackCodexJob) {
  const count = job.resolvedEpisodeCount || job.episodeCount;
  return Array.from({ length: count }, (_, index) => index + 1);
}

function asJsonRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SeasonPackCodexQueueError(`${label} must contain one JSON object`, "FINALIZATION_SCHEMA_INVALID");
  }
  return value as Record<string, unknown>;
}

function validateSeasonModelManifest(
  job: SeasonPackCodexJob,
  manifest: Record<string, unknown>,
  expectedEpisodeCount: number,
) {
  const declaredCount = normalizePositiveInteger(manifest.episodeCount)
    || normalizePositiveInteger(manifest.resolvedEpisodeCount)
    || normalizePositiveInteger(manifest.segmentCount);
  if (job.segmentCountMode === "fixed" && declaredCount && declaredCount !== job.episodeCount) {
    throw new SeasonPackCodexQueueError(
      `Season Pack manifest episodeCount ${declaredCount} does not match requested segment count ${job.episodeCount}`,
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  if (declaredCount && declaredCount !== expectedEpisodeCount) {
    throw new SeasonPackCodexQueueError(
      `Season Pack manifest episodeCount ${declaredCount} does not match resolved segment count ${expectedEpisodeCount}`,
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  const generatedEpisodes = Array.isArray(manifest.generatedEpisodes)
    ? manifest.generatedEpisodes.map(normalizePositiveInteger)
    : [];
  if (generatedEpisodes.length) {
    const expected = Array.from({ length: expectedEpisodeCount }, (_, index) => index + 1);
    const sorted = [...generatedEpisodes].sort((left, right) => left - right);
    if (generatedEpisodes.some((index) => !index)
      || new Set(generatedEpisodes).size !== generatedEpisodes.length
      || JSON.stringify(sorted) !== JSON.stringify(expected)) {
      throw new SeasonPackCodexQueueError(
        "Season Pack manifest generatedEpisodes must be contiguous, unique, and match the requested segments",
        "FINALIZATION_IDENTITY_MISMATCH",
      );
    }
  }
}

async function validateExactSeasonEpisodeFiles(episodesDir: string, expectedIndexes: number[]) {
  let actualIndexes: number[];
  try {
    const entries = await readdir(episodesDir, { withFileTypes: true });
    actualIndexes = entries
      .filter((entry) => entry.isFile() && /^episode-\d{3}\.json$/i.test(entry.name))
      .map((entry) => Number.parseInt(entry.name.slice(8, 11), 10))
      .sort((left, right) => left - right);
  } catch (error) {
    throw new SeasonPackCodexQueueError("Season Pack episode output directory is missing", "FINALIZATION_OUTPUT_MISSING");
  }
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    const missing = expectedIndexes.filter((index) => !actualIndexes.includes(index));
    const extra = actualIndexes.filter((index) => !expectedIndexes.includes(index));
    const details = [
      ...missing.map((index) => `missing ${episodeFileName(index)}`),
      ...extra.map((index) => `unexpected ${episodeFileName(index)}`),
    ].join(", ");
    throw new SeasonPackCodexQueueError(
      `Season Pack episode files do not exactly match requested indexes: ${details}`,
      "FINALIZATION_OUTPUT_MISSING",
    );
  }
}

function resolveSeasonResultDirectory(rootDir: string, resultRef: CodexFinalizedResultRef) {
  if (resultRef.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION) {
    throw new SeasonPackCodexQueueError("Season Pack result reference protocol is invalid", "FINALIZATION_SCHEMA_INVALID");
  }
  const queueRoot = path.resolve(rootDir, TASK_ROOT);
  const resultRoot = path.resolve(queueRoot, "results");
  const resultDir = path.resolve(queueRoot, ...String(resultRef.relativePath || "").split("/"));
  if (!resultDir.startsWith(`${resultRoot}${path.sep}`)) {
    throw new SeasonPackCodexQueueError("Season Pack result reference escapes its immutable result root", "FINALIZATION_SCHEMA_INVALID");
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

function assertSeasonPackLease(job: SeasonPackCodexJob, leaseId: string, fencingToken: number) {
  if (!leaseId || job.leaseId !== leaseId || !Number.isInteger(fencingToken) || job.fencingToken !== fencingToken) {
    throw new SeasonPackCodexQueueError("Season Pack lease is stale or invalid", "FINALIZATION_STALE_FENCE");
  }
}

export async function recoverFinalizedSeasonPackCodexJobs(rootDir: string) {
  const runningJobs = await listFileJobsByStatus<SeasonPackCodexJob>(rootDir, TASK_ROOT, "running");
  let recovered = 0;
  for (const stored of runningJobs) {
    const job = normalizeStoredSeasonPackJob(stored);
    if (job.protocolVersion !== CODEX_FINALIZATION_PROTOCOL_VERSION
      || job.status !== "running"
      || job.stage !== "finalizing"
      || !job.leaseId) continue;
    try {
      const recovery = job.resultRef && job.contractHash
        ? {
            resultRef: job.resultRef,
            contractHash: job.contractHash,
            segmentIndexes: seasonSegmentIndexes(job),
          }
        : await recoverSeasonPackResultReference(rootDir, job);
      if (!recovery) continue;
      if (!job.resultRef || !sameResultRef(job.resultRef, recovery.resultRef) || job.contractHash !== recovery.contractHash) {
        await updateRunningFileJob<SeasonPackCodexJob>(
          rootDir,
          TASK_ROOT,
          job.id,
          job.leaseId,
          job.fencingToken,
          {
            stage: "finalizing",
            contractHash: recovery.contractHash,
            resultRef: recovery.resultRef,
            resultAvailable: false,
            resolvedEpisodeCount: recovery.segmentIndexes.length,
            episodeCount: job.segmentCountMode === "auto" ? recovery.segmentIndexes.length : job.episodeCount,
          },
        );
      }
      await completeSeasonPackCodexJob(
        job.id,
        job.leaseId,
        job.fencingToken,
        recovery.resultRef,
        { rootDir },
      );
      recovered += 1;
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code || "");
      if (code === "FINALIZATION_OUTPUT_MISSING" || code === "FINALIZATION_STALE_FENCE") continue;
      if (code === "FINALIZATION_ATOMIC_REPLACE_FAILED") throw error;
      await failSeasonPackCodexJob(
        job.id,
        job.leaseId,
        job.fencingToken,
        error instanceof Error ? error.message : "Season Pack finalization recovery failed",
        code || "FINALIZATION_SCHEMA_INVALID",
        { rootDir },
      ).catch((failure) => {
        if (String((failure as { code?: unknown } | null)?.code || "") !== "FINALIZATION_STALE_FENCE") throw failure;
      });
    }
  }
  return recovered;
}

async function recoverSeasonPackResultReference(rootDir: string, job: SeasonPackCodexJob) {
  if (job.stagingDir) {
    try {
      const recovery = await validateRecoverableSeasonPackDirectory(job, job.stagingDir);
      const resultRef = await publishFinalizedJob({
        ...seasonPackRecoveryIdentity(rootDir, job, recovery),
        stagingDir: job.stagingDir,
      });
      return { ...recovery, resultRef };
    } catch (error) {
      if (String((error as { code?: unknown } | null)?.code || "") !== "FINALIZATION_OUTPUT_MISSING") throw error;
    }
  }

  const resultRoot = path.join(rootDir, TASK_ROOT, "results", job.id);
  const entries = await readdir(resultRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = path.join(resultRoot, entry.name);
    try {
      const recovery = await validateRecoverableSeasonPackDirectory(job, directory);
      if (recovery.resultHash !== entry.name) {
        throw new SeasonPackCodexQueueError(
          "Season Pack immutable directory does not match its result hash",
          "FINALIZATION_HASH_MISMATCH",
        );
      }
      return {
        ...recovery,
        resultRef: buildFinalizedResultRef(job.id, recovery.resultHash),
      };
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code || "");
      if (code === "FINALIZATION_STALE_FENCE" || code === "FINALIZATION_IDENTITY_MISMATCH") continue;
      throw error;
    }
  }
  return null;
}

async function validateRecoverableSeasonPackDirectory(job: SeasonPackCodexJob, directory: string) {
  const manifest = await readAndValidateRecoverableFinalManifest({
    directory,
    expected: {
      jobId: job.id,
      taskClass: "season_pack",
      leaseId: job.leaseId!,
      fencingToken: job.fencingToken,
      sourceHash: job.sourceHash,
    },
  });
  const result = await readSeasonPackResult(bindSeasonPackJobToPublishedResult(job, directory));
  const segmentIndexes = result.episodes.map((episode) => episode.episodeIndex).sort((left, right) => left - right);
  const expectedIndexes = Array.from({ length: segmentIndexes.length }, (_, index) => index + 1);
  if (JSON.stringify(segmentIndexes) !== JSON.stringify(expectedIndexes)
    || (job.segmentCountMode === "fixed" && segmentIndexes.length !== job.episodeCount)) {
    throw new SeasonPackCodexQueueError(
      "Recoverable Season Pack segment identities do not match the request",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  const contractHash = seasonResultContractHash(result);
  if (manifest.contractHash !== contractHash
    || JSON.stringify(manifest.segmentIndexes) !== JSON.stringify(segmentIndexes)
    || hashCanonicalJson(result) !== manifest.resultHash) {
    throw new SeasonPackCodexQueueError(
      "Recoverable Season Pack identity or canonical result hash does not match its manifest",
      "FINALIZATION_HASH_MISMATCH",
    );
  }
  const expectedPaths = [
    "manifest.json",
    "season-plan.json",
    ...segmentIndexes.map((episodeIndex) => path.posix.join("episodes", episodeFileName(episodeIndex))),
  ].sort((left, right) => left.localeCompare(right));
  const actualPaths = manifest.outputFiles.map((output) => output.relativePath).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new SeasonPackCodexQueueError(
      "Season Pack manifest does not list exactly the requested outputs",
      "FINALIZATION_IDENTITY_MISMATCH",
    );
  }
  return { resultHash: manifest.resultHash, contractHash, segmentIndexes };
}

function seasonPackRecoveryIdentity(
  rootDir: string,
  job: SeasonPackCodexJob,
  recovery: { resultHash: string; contractHash: string; segmentIndexes: number[] },
) {
  return {
    rootDir,
    namespace: TASK_ROOT,
    jobId: job.id,
    taskClass: "season_pack" as const,
    leaseId: job.leaseId!,
    fencingToken: job.fencingToken,
    sourceHash: job.sourceHash,
    contractHash: recovery.contractHash,
    segmentIndexes: recovery.segmentIndexes,
    resultHash: recovery.resultHash,
  };
}

function seasonResultContractHash(result: SeasonPackCodexJobResult) {
  return hashCanonicalJson(result.episodes.map((episode) => ({
    episodeIndex: episode.episodeIndex,
    contractHash: episode.input.segmentContract?.contractHash || null,
    lockedSegmentPlan: episode.input.lockedSegmentPlan || null,
  })));
}

async function canRecoverSeasonPackJob(rootDir: string, job: SeasonPackCodexJob) {
  const runtime = await readCodexRuntimeHealth("season-pack", { rootDir, maxAgeMs: 90_000 });
  if (runtime.status === "healthy") return false;
  return true;
}

async function readLegacySeasonPackJob(rootDir: string, jobId: string) {
  const legacy = normalizeStoredSeasonPackJob(await readJob(rootDir, jobId));
  return syncAndSaveJob(rootDir, legacy);
}

function mapSeasonFinalizationError(error: CodexJobFinalizationError) {
  return new SeasonPackCodexQueueError(error.message, error.code);
}

async function syncAndSaveJob(rootDir: string, job: SeasonPackCodexJob) {
  const synced = await syncJobFromOutputFiles(job);
  const finalized = applyJobStatus(synced);
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    await writeJob(rootDir, finalized);
  }
  return finalized;
}

async function syncJobFromOutputFiles(job: SeasonPackCodexJob) {
  if (job.status === "completed") return job;
  if (!(await isValidSeasonPack(job))) return job;
  const result = await readSeasonPackResult(job);
  const resolvedEpisodeCount = result.episodes.length;

  return {
    ...job,
    episodeCount: job.segmentCountMode === "auto" ? resolvedEpisodeCount : job.episodeCount,
    resolvedEpisodeCount,
    status: "completed" as const,
    result,
    error: null,
    completedAt: job.completedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function recoverStaleRunningJob(job: SeasonPackCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0 || job.status !== "running") return job;

  const startedAtMs = Date.parse(job.startedAt || job.updatedAt || job.createdAt);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < runningTimeoutMs) return job;

  return {
    ...job,
    status: "pending" as const,
    startedAt: undefined,
    error: "Previous Codex run exceeded the season pack task timeout and was returned to the queue",
    updatedAt: new Date().toISOString(),
  };
}

function applyJobStatus(job: SeasonPackCodexJob): SeasonPackCodexJob {
  if (job.status === "completed") return { ...job, error: null };
  if (job.status === "running") return { ...job, error: null };
  if (job.status === "failed") return job;
  return { ...job, status: "pending", error: null };
}

async function listJobs(rootDir: string) {
  await ensureQueueDirs(rootDir);
  const entries = await readdir(jobDir(rootDir), { withFileTypes: true });
  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJob(rootDir, entry.name.replace(/\.json$/, ""))),
  );
  return jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

async function readJob(rootDir: string, jobId: string): Promise<SeasonPackCodexJob> {
  try {
    const parsed = JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as SeasonPackCodexJob;
    return {
      ...parsed,
      featureFlags: normalizeBatchEventFeatureSnapshot(parsed.featureFlags, parsed.createdAt),
      safetyDiffs: Array.isArray(parsed.safetyDiffs) ? parsed.safetyDiffs : [],
    };
  } catch (error) {
    throw new SeasonPackCodexQueueError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "Season pack Codex job not found" : "Season pack Codex job could not be read",
    );
  }
}

async function writeJob(rootDir: string, job: SeasonPackCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
  await mkdir(packRootDir(rootDir), { recursive: true });
}

async function readSeasonPackResult(job: SeasonPackCodexJob): Promise<SeasonPackCodexJobResult> {
  const episodes: SeasonPackEpisodeResult[] = [];
  const sourceContext = parseSeasonSourceContext(job.script);
  const manifest = await readOptionalJson(job.manifestPath);
  const rawSeasonPlan = sanitizeSeasonPlanningPlaceholders(await readOptionalJson(job.seasonPlanPath)) as Record<string, unknown> | null;
  const lockedSeasonPlan = buildLockedSeasonPlan(rawSeasonPlan, job.featureFlags.coveragePolicyVersion);
  const episodeCount = resolveSeasonPackEpisodeCount(job, manifest, lockedSeasonPlan.segments.length);
  validateLockedSeasonPlanCount(lockedSeasonPlan.segments, episodeCount);
  const lockedSegmentsByIndex = new Map(lockedSeasonPlan.segments.map((segment) => [segment.segmentIndex, segment]));
  const segmentContractsByIndex = new Map(lockedSeasonPlan.segmentContracts.map((contract) => [contract.segmentIndex, contract]));
  for (let episodeIndex = 1; episodeIndex <= episodeCount; episodeIndex += 1) {
    const fileName = episodeFileName(episodeIndex);
    const filePath = path.join(job.episodesDir, fileName);
    const input = await readOutputJson(filePath, {
      sourceText: job.script,
      episodeIndex,
      episodeCount,
      duration: job.duration,
      contentType: job.contentType,
      style: job.style,
      sourceContext,
      lockedSegment: lockedSegmentsByIndex.get(episodeIndex),
      segmentContract: segmentContractsByIndex.get(episodeIndex),
    });
    episodes.push({ episodeIndex, fileName, input });
  }

  return {
    manifest,
    seasonPlan: seasonPlanWithLockedSegments(rawSeasonPlan, lockedSeasonPlan),
    episodes,
  };
}

async function readOutputJson(filePath: string, context: OutputJsonContext | string = ""): Promise<SeasonPackEpisodeInput> {
  const outputContext = typeof context === "string"
    ? {
      sourceText: context,
      episodeIndex: 1,
      episodeCount: 1,
      duration: "auto",
      contentType: "短剧 / 通用",
      style: "自动匹配文案气质",
      sourceContext: parseSeasonSourceContext(context),
    }
    : context;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new SeasonPackCodexQueueError(`Season pack output file is empty: ${filePath}`);
    }
    const result = sanitizeSeasonPlanningPlaceholders(
      JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))),
    ) as Record<string, unknown>;
    const input = normalizeEpisodeInputPack(result, outputContext);
    validateEpisodeInputPack(input, result, outputContext);
    validateEncodingQuality(input as unknown as Record<string, unknown>, outputContext.sourceText);
    return input;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SeasonPackCodexQueueError(`Season pack output file is missing: ${filePath}`);
    }
    throw new SeasonPackCodexQueueError(
      error instanceof SeasonPackCodexQueueError
        ? error.message
        : `Codex did not produce valid season pack JSON: ${filePath}`,
    );
  }
}

async function readOptionalJson(filePath: string) {
  try {
    return JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function isValidSeasonPack(job: SeasonPackCodexJob) {
  try {
    await readSeasonPackResult(job);
    return true;
  } catch {
    return false;
  }
}

function buildLockedSeasonPlan(seasonPlan: Record<string, unknown> | null, coveragePolicyVersion: string) {
  const beats = normalizeSeasonPlanBeats(seasonPlan);
  const segments = beats.length ? packBeatsIntoLockedSegments(beats) : normalizeSeasonPlanSegments(seasonPlan);
  const segmentContracts = normalizeSeasonPlanSegmentContracts(seasonPlan, segments, coveragePolicyVersion);
  return { beats, segments, segmentContracts };
}

function normalizeSeasonPlanSegmentContracts(
  seasonPlan: Record<string, unknown> | null,
  segments: LockedSeasonSegment[],
  coveragePolicyVersion: string,
) {
  const rawContracts = Array.isArray(seasonPlan?.segmentContracts)
    ? seasonPlan.segmentContracts
    : Array.isArray(seasonPlan?.contracts)
      ? seasonPlan.contracts
      : [];
  const rawByIndex = new Map<number, unknown>();
  rawContracts.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    rawByIndex.set(normalizePositiveInteger(record.segmentIndex) || index + 1, record);
  });

  return segments.map((segment, index) => {
    const futureEvents = segments
      .slice(index + 1)
      .flatMap((future) => future.sourceText.split(/\n|[;；。]/).map((item) => item.trim()).filter(Boolean))
      .slice(0, 8);
    const contract = normalizeSegmentContract(rawByIndex.get(segment.segmentIndex), {
      segmentIndex: segment.segmentIndex,
      fallbackTitle: segment.title || `Segment ${segment.segmentIndex}`,
      fallbackSourceText: segment.sourceText,
      fallbackDurationSeconds: segment.estimatedDurationSeconds,
      fallbackShotCount: segment.shotCount,
      coveragePolicyVersion,
      forbiddenFutureEvents: futureEvents,
    });
    validateSegmentContract(contract, segment.segmentIndex);
    return contract;
  });
}

function normalizeSeasonPlanBeats(seasonPlan: Record<string, unknown> | null): SeasonPackBeat[] {
  const rawBeats = Array.isArray(seasonPlan?.beats) ? seasonPlan.beats : [];
  return rawBeats.flatMap((rawBeat, index) => {
    if (!rawBeat || typeof rawBeat !== "object") return [];
    const beat = rawBeat as Record<string, unknown>;
    const id = cleanString(beat.id) || `B${String(index + 1).padStart(3, "0")}`;
    const summary = cleanString(beat.summary) || cleanString(beat.title) || cleanString(beat.event) || `Beat ${index + 1}`;
    const sourceText = cleanString(beat.sourceText) || cleanString(beat.text) || summary;
    const estimatedDurationSeconds = normalizeBeatDurationSeconds(
      beat.estimatedDurationSeconds ?? beat.durationSeconds ?? beat.duration,
    );
    const shotCount = normalizeShotCount(beat.shotCount) || inferBeatShotCount(estimatedDurationSeconds);
    return splitOversizedBeat({
      id,
      summary,
      sourceText,
      estimatedDurationSeconds,
      shotCount,
    });
  });
}

function splitOversizedBeat(beat: SeasonPackBeat): SeasonPackBeat[] {
  if (beat.estimatedDurationSeconds <= 15) return [beat];
  const partCount = Math.ceil(beat.estimatedDurationSeconds / 12);
  const partDuration = roundDurationSeconds(beat.estimatedDurationSeconds / partCount);
  const partShotCount = Math.max(1, Math.ceil(beat.shotCount / partCount));
  return Array.from({ length: partCount }, (_, index) => ({
    ...beat,
    id: `${beat.id}-${index + 1}`,
    summary: `${beat.summary} (${index + 1}/${partCount})`,
    estimatedDurationSeconds: partDuration,
    shotCount: partShotCount,
  }));
}

function packBeatsIntoLockedSegments(beats: SeasonPackBeat[]): LockedSeasonSegment[] {
  const segments: LockedSeasonSegment[] = [];
  let current: SeasonPackBeat[] = [];
  let currentDuration = 0;

  function flushCurrent() {
    if (!current.length) return;
    const segmentIndex = segments.length + 1;
    const duration = roundDurationSeconds(current.reduce((sum, beat) => sum + beat.estimatedDurationSeconds, 0));
    segments.push({
      segmentIndex,
      title: `第 ${segmentIndex} 段：${current[0].summary}`,
      beatStart: beats.indexOf(current[0]) + 1,
      beatEnd: beats.indexOf(current[current.length - 1]) + 1,
      beatIds: current.map((beat) => beat.id),
      estimatedDurationSeconds: duration,
      shotCount: lockedSegmentShotCount(duration, current),
      sourceText: current.map((beat) => `${beat.id}: ${beat.sourceText}`).join("\n"),
    });
    current = [];
    currentDuration = 0;
  }

  for (const beat of beats) {
    const nextDuration = roundDurationSeconds(currentDuration + beat.estimatedDurationSeconds);
    if (current.length && nextDuration > 15) {
      flushCurrent();
    }
    current.push(beat);
    currentDuration = roundDurationSeconds(currentDuration + beat.estimatedDurationSeconds);
  }
  flushCurrent();
  return mergeShortLockedSegments(segments);
}

function mergeShortLockedSegments(segments: LockedSeasonSegment[]) {
  if (segments.length < 2) return segments;
  const merged: LockedSeasonSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const combinedDuration = previous
      ? roundDurationSeconds(previous.estimatedDurationSeconds + segment.estimatedDurationSeconds)
      : 0;
    if (previous && segment.estimatedDurationSeconds < 7 && combinedDuration <= 15) {
      previous.beatEnd = segment.beatEnd;
      previous.beatIds = [...previous.beatIds, ...segment.beatIds];
      previous.estimatedDurationSeconds = combinedDuration;
      previous.shotCount = Math.min(5, Math.max(previous.shotCount, segment.shotCount, minimumShotCountForDuration(`${combinedDuration}秒`)));
      previous.sourceText = `${previous.sourceText}\n${segment.sourceText}`;
      continue;
    }
    merged.push({ ...segment, segmentIndex: merged.length + 1 });
  }
  return merged.map((segment, index) => ({
    ...segment,
    segmentIndex: index + 1,
    title: segment.title.replace(/^第\s*\d+\s*段/, `第 ${index + 1} 段`),
  }));
}

function normalizeSeasonPlanSegments(seasonPlan: Record<string, unknown> | null): LockedSeasonSegment[] {
  const rawSegments = Array.isArray(seasonPlan?.lockedSegments)
    ? seasonPlan.lockedSegments
    : Array.isArray(seasonPlan?.segments)
      ? seasonPlan.segments
      : [];
  return rawSegments.flatMap((rawSegment, index) => {
    if (!rawSegment || typeof rawSegment !== "object") return [];
    const segment = rawSegment as Record<string, unknown>;
    const hasLockedSegmentFields = Array.isArray(segment.beatIds)
      || segment.beatStart !== undefined
      || segment.beatEnd !== undefined
      || segment.estimatedDurationSeconds !== undefined
      || segment.targetDurationSeconds !== undefined
      || segment.durationSeconds !== undefined
      || segment.sourceText !== undefined;
    if (!hasLockedSegmentFields) return [];
    const estimatedDurationSeconds = normalizeBeatDurationSeconds(
      segment.estimatedDurationSeconds ?? segment.targetDurationSeconds ?? segment.durationSeconds ?? segment.duration,
    );
    if (estimatedDurationSeconds > 15) {
      throw new SeasonPackCodexQueueError(`Locked segment ${index + 1} exceeds 15 seconds`);
    }
    const beatIds = Array.isArray(segment.beatIds)
      ? segment.beatIds.map((value) => cleanString(value)).filter(Boolean)
      : [];
    return [{
      segmentIndex: normalizePositiveInteger(segment.segmentIndex) || index + 1,
      title: cleanString(segment.title),
      beatStart: normalizePositiveInteger(segment.beatStart) || index + 1,
      beatEnd: normalizePositiveInteger(segment.beatEnd) || index + 1,
      beatIds,
      estimatedDurationSeconds,
      shotCount: normalizeShotCount(segment.shotCount) || minimumShotCountForDuration(`${estimatedDurationSeconds}秒`) || 4,
      sourceText: cleanString(segment.sourceText) || cleanString(segment.summary) || beatIds.join(", "),
    }];
  });
}

function seasonPlanWithLockedSegments(
  seasonPlan: Record<string, unknown> | null,
  lockedSeasonPlan: { beats: SeasonPackBeat[]; segments: LockedSeasonSegment[]; segmentContracts: SegmentContract[] },
) {
  if (!lockedSeasonPlan.segments.length) return seasonPlan;
  return {
    ...(seasonPlan || {}),
    beats: lockedSeasonPlan.beats.length ? lockedSeasonPlan.beats : seasonPlan?.beats,
    lockedSegments: lockedSeasonPlan.segments,
    segmentContracts: lockedSeasonPlan.segmentContracts,
    segmentPlanMode: "beat_locked",
    segmentDurationLimitSeconds: 15,
  };
}

function validateLockedSeasonPlanCount(segments: LockedSeasonSegment[], episodeCount: number) {
  if (!segments.length) {
    throw new SeasonPackCodexQueueError(
      "Season pack output is missing a locked beat plan: season-plan.json must include beats or lockedSegments before rendering",
    );
  }
  if (segments.length !== episodeCount) {
    throw new SeasonPackCodexQueueError(
      `Locked SegmentPlan count ${segments.length} does not match resolved segment count ${episodeCount}`,
    );
  }
  for (const segment of segments) {
    if (segment.estimatedDurationSeconds > 15) {
      throw new SeasonPackCodexQueueError(`Locked segment ${segment.segmentIndex} exceeds 15 seconds`);
    }
  }
}

function normalizeBeatDurationSeconds(value: unknown) {
  const seconds = typeof value === "number" ? value : parseDurationSeconds(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 3;
  return roundDurationSeconds(seconds);
}

function inferBeatShotCount(seconds: number) {
  if (seconds <= 4) return 1;
  if (seconds <= 8) return 2;
  return 3;
}

function lockedSegmentShotCount(duration: number, beats: SeasonPackBeat[]) {
  const minimum = minimumShotCountForDuration(`${duration}秒`) || 2;
  const maximum = maximumShotCountForDuration(`${duration}秒`) || 5;
  const fromBeats = beats.reduce((sum, beat) => sum + beat.shotCount, 0);
  return Math.min(maximum, Math.max(minimum, fromBeats));
}

function roundDurationSeconds(value: number) {
  return Number(value.toFixed(1));
}

function durationLabelFromSeconds(value: number) {
  return `${formatSeconds(value)}秒`;
}

function resolveSeasonPackEpisodeCount(
  job: SeasonPackCodexJob,
  manifest: Record<string, unknown> | null,
  lockedSegmentCount = 0,
) {
  const mode = job.segmentCountMode === "auto" ? "auto" : "fixed";
  if (mode === "fixed") return job.episodeCount;

  const manifestCount = normalizePositiveInteger(manifest?.episodeCount)
    || normalizePositiveInteger(manifest?.resolvedEpisodeCount)
    || normalizePositiveInteger(manifest?.segmentCount);
  const generatedEpisodes = Array.isArray(manifest?.generatedEpisodes)
    ? manifest.generatedEpisodes
        .map((value) => normalizePositiveInteger(value))
        .filter((value): value is number => Boolean(value))
    : [];
  const generatedCount = generatedEpisodes.length;
  const resolvedCount = manifestCount || lockedSegmentCount || generatedCount || normalizePositiveInteger(job.resolvedEpisodeCount);
  if (!resolvedCount || resolvedCount < 1 || resolvedCount > MAX_EPISODE_COUNT) {
    throw new SeasonPackCodexQueueError("Automatic season pack manifest must resolve between 1 and 30 segments");
  }
  if (generatedCount > 0 && manifestCount && generatedCount !== manifestCount) {
    throw new SeasonPackCodexQueueError("Automatic season pack manifest episodeCount does not match generatedEpisodes");
  }
  return resolvedCount;
}

function normalizePositiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function stripJsonBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function validateEncodingQuality(result: Record<string, unknown>, sourceText: string) {
  const sourceCjkCount = countCjkCharacters(sourceText);
  if (sourceCjkCount < 3) return;

  const serialized = JSON.stringify(result);
  const questionMarkCount = countQuestionMarks(serialized);
  const replacementCharCount = countReplacementCharacters(serialized);
  const resultCjkCount = countCjkCharacters(serialized);

  if (replacementCharCount > 0) {
    throw new SeasonPackCodexQueueError("Season pack JSON encoding appears damaged: replacement characters were found");
  }
  if (questionMarkCount >= 20 && questionMarkCount > Math.max(60, resultCjkCount * 2)) {
    throw new SeasonPackCodexQueueError("Season pack JSON encoding appears damaged: excessive question marks in Chinese output");
  }
}

function normalizeEpisodeInputPack(result: Record<string, unknown>, context: OutputJsonContext): SeasonPackEpisodeInput {
  const sourceSegment = context.sourceContext.segments.get(context.episodeIndex);
  const lockedSegment = context.lockedSegment;
  const normalizedSegmentContract = normalizeSegmentContract(context.segmentContract || result.segmentContract, {
    segmentIndex: context.episodeIndex,
    fallbackTitle: lockedSegment?.title || cleanString(result.title) || `Segment ${context.episodeIndex}`,
    fallbackSourceText: lockedSegment?.sourceText || cleanString(result.sourceText) || context.sourceText,
    fallbackDurationSeconds: lockedSegment?.estimatedDurationSeconds || parseDurationSeconds(context.duration) || 15,
    fallbackShotCount: lockedSegment?.shotCount || normalizeShotCount(result.shotCount) || 4,
  });
  const title = normalizeSegmentTitle(lockedSegment?.title || "", context.episodeIndex)
    || normalizeSegmentTitle(cleanString(result.title), context.episodeIndex)
    || (sourceSegment ? `第${context.episodeIndex}段｜${sourceSegment.title}` : "")
    || `第${context.episodeIndex}段`;
  const duration = (lockedSegment ? durationLabelFromSeconds(lockedSegment.estimatedDurationSeconds) : "")
    || cleanString(result.duration)
    || sourceSegment?.duration
    || normalizeDurationLabel(context.duration)
    || "15秒";
  const contentType = cleanContentTypeLabel(result.contentType)
    || inferContentTypeFromSource(context.sourceText)
    || normalizeLooseLabel(context.contentType)
    || "短剧 / 通用";
  const style = cleanString(result.style)
    || inferStyleFromSource(context.sourceText)
    || normalizeLooseLabel(context.style)
    || "电影级写实";
  const sourceText = cleanSourceEpisodeLabels(lockedSegment?.sourceText
    || cleanString(result.sourceText)
    || extractSeasonSourceSegmentText(context.sourceText, context.episodeIndex)
    || context.sourceText);
  const shotCount = lockedSegment?.shotCount
    || normalizedSegmentContract.shotCount
    || normalizeShotCount(result.shotCount)
    || sourceSegment?.shotCount
    || minimumShotCountForDuration(duration)
    || minimumShotCountForDuration(context.duration)
    || 4;
  const segmentContract = reconcileSegmentContractShotCount(normalizedSegmentContract, shotCount);
  const storyBible = isMeaningfulValue(result.storyBible) ? result.storyBible : {};
  const episodeChain = isMeaningfulValue(result.episodeChain) ? result.episodeChain : {};
  const blueprint = isMeaningfulValue(result.blueprint) ? result.blueprint : {};

  const partial: SeasonPackEpisodeInput = {
    episodeIndex: context.episodeIndex,
    title,
    sourceText,
    duration,
    contentType,
    style,
    storyBible,
    episodeChain,
    blueprint,
    shotCount,
    renderInputScript: "",
    beatIds: lockedSegment?.beatIds,
    beatRange: lockedSegment
      ? {
        start: lockedSegment.beatStart,
        end: lockedSegment.beatEnd,
      }
      : undefined,
    targetDurationSeconds: lockedSegment?.estimatedDurationSeconds,
    lockedSegmentPlan: lockedSegment,
    segmentContract,
  };
  partial.renderInputScript = appendSegmentContractPlan(
    appendLockedSegmentPlan(
      normalizeRenderInputScript(cleanSourceEpisodeLabels(cleanString(result.renderInputScript) || buildEpisodeRenderInputScript(partial))),
      lockedSegment,
    ),
    segmentContract,
  );
  return partial;
}

function reconcileSegmentContractShotCount(contract: SegmentContract, shotCount: number): SegmentContract {
  const targetShotCount = normalizeShotCount(shotCount) || contract.shotCount;
  if (contract.shotCount === targetShotCount && contract.requiredShotBeats.length <= targetShotCount) {
    return contract;
  }

  const requiredShotBeats = contract.requiredShotBeats
    .slice(0, targetShotCount)
    .map((beat, index) => ({
      ...beat,
      shotNumber: index + 1,
    }));

  while (requiredShotBeats.length < targetShotCount) {
    const shotNumber = requiredShotBeats.length + 1;
    requiredShotBeats.push({
      shotNumber,
      timeRange: "",
      beat: contract.requiredEvents[shotNumber - 1] || contract.requiredEvents[0] || contract.sourceText,
      visualFocus: contract.title,
    });
  }

  const { contractHash: _ignored, ...contractWithoutHash } = contract;
  const updatedContract = {
    ...contractWithoutHash,
    shotCount: targetShotCount,
    requiredShotBeats,
  };

  return {
    ...updatedContract,
    contractHash: buildSegmentContractHash(updatedContract),
  };
}

function validateEpisodeInputPack(
  input: SeasonPackEpisodeInput,
  raw: Record<string, unknown>,
  context: OutputJsonContext,
) {
  const workflow = raw.workflow && typeof raw.workflow === "object"
    ? raw.workflow as Record<string, unknown>
    : {};
  if (Array.isArray(raw.storyboard) || cleanString(workflow.fullVideoPrompt)) {
    throw new SeasonPackCodexQueueError("Season pack episode file must be an Episode Input Pack, not a final AnalysisResult");
  }
  for (const field of REQUIRED_EPISODE_INPUT_FIELDS) {
    if (hasPoisonedGeneratedText(raw[field])) {
      throw new SeasonPackCodexQueueError("Season pack episode input pack contains invalid undefined/null text");
    }
  }

  for (const field of REQUIRED_EPISODE_INPUT_FIELDS) {
    if (typeof input[field as keyof SeasonPackEpisodeInput] !== "string" || !String(input[field as keyof SeasonPackEpisodeInput]).trim()) {
      throw new SeasonPackCodexQueueError(`Season pack episode input pack is missing ${field}`);
    }
  }
  if (input.episodeIndex !== context.episodeIndex) {
    throw new SeasonPackCodexQueueError(`Season pack episode input pack index ${input.episodeIndex} does not match expected ${context.episodeIndex}`);
  }
  if (!Number.isInteger(input.shotCount) || input.shotCount < 1) {
    throw new SeasonPackCodexQueueError("Season pack episode input pack is missing shotCount");
  }
  if (context.lockedSegment && parseDurationSeconds(input.duration) > 15) {
    throw new SeasonPackCodexQueueError(`Season pack episode ${context.episodeIndex} exceeds locked 15 second segment duration`);
  }
  if (context.lockedSegment && input.shotCount !== context.lockedSegment.shotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context.episodeIndex} shotCount ${input.shotCount} does not match locked SegmentPlan shotCount ${context.lockedSegment.shotCount}`,
    );
  }
  if (input.segmentContract) {
    try {
      validateSegmentContract(input.segmentContract, context.episodeIndex);
    } catch (error) {
      throw new SeasonPackCodexQueueError(error instanceof Error ? error.message : "Season pack episode input pack has an invalid SegmentContract");
    }
    if (input.segmentContract.shotCount !== input.shotCount) {
      throw new SeasonPackCodexQueueError(
        `Season pack episode ${context.episodeIndex} shotCount ${input.shotCount} does not match SegmentContract shotCount ${input.segmentContract.shotCount}`,
      );
    }
  }
  const sourceSegment = context.sourceContext.segments.get(context.episodeIndex);
  const maximumShotCount = maximumShotCountForDuration(input.duration || context.duration);
  if (maximumShotCount > 0 && input.shotCount > maximumShotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context.episodeIndex} has too many planned shots: ${input.shotCount} / ${maximumShotCount}`,
    );
  }
  if (sourceSegment?.shotCount && sourceSegment.shotCount <= (maximumShotCount || Number.POSITIVE_INFINITY) && input.shotCount !== sourceSegment.shotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context.episodeIndex} shotCount ${input.shotCount} does not match source segment shot count ${sourceSegment.shotCount}`,
    );
  }
  const minimumShotCount = sourceSegment?.shotCount ? 0 : minimumInputPackShotCount(input, context);
  if (minimumShotCount > 0 && input.shotCount < minimumShotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context.episodeIndex} has too few planned shots: ${input.shotCount} / ${minimumShotCount}`,
    );
  }
  if (hasPoisonedGeneratedText(input.renderInputScript) || hasPoisonedGeneratedText(input.title)) {
    throw new SeasonPackCodexQueueError("Season pack episode input pack contains invalid undefined/null text");
  }
}

function buildEpisodeRenderInputScript(input: SeasonPackEpisodeInput) {
  return [
    `你正在为 Local Director 生成第 ${input.episodeIndex} 段的视频提示词。`,
    "",
    "单段渲染输入：必须按普通单段生成的质量和结构输出完整视频提示词结果 JSON。",
    "不要输出摘要版，不要压缩镜头，不要省略镜头字段。",
    "最终标题、核心主题和完整视频提示词都必须使用“段”，不要写“第N集”或“本集”。",
    "",
    `标题：${input.title}`,
    `时长：${input.duration}`,
    `内容类型：${input.contentType}`,
    `风格：${input.style}`,
    `镜头数量锁：${input.shotCount} 个镜头。最终 storyboard 必须严格等于这个数量。`,
    "",
    "项目固定记忆：",
    stringifyPlanningValue(input.storyBible),
    "",
    "本段前后承接：",
    stringifyPlanningValue(input.episodeChain),
    "",
    "本段结构规划：",
    stringifyPlanningValue(input.blueprint),
    "",
    "本段原文案：",
    input.sourceText,
    "",
    "生成要求：",
    "1. 使用和单段独立生成完全相同的质量标准，输出完整视频生成提示词和逐镜头分镜。",
    "2. 保留本段原文案的关键事件、人物关系、时间线、道具线索和情绪推进。",
    "3. 读取 Story Bible 和 Segment Chain 保持跨段连续性，但不要提前泄露后续内容。",
    "4. 每个镜头必须包含时间范围、景别、机位/构图、运镜、画面、光影、声音/台词、情绪、转场、镜头目的、firstFramePrompt、videoPrompt、lastFramePrompt、negativePrompt。",
    "5. 15 秒默认 4-5 镜头；除非用户明确要求密集镜头版，否则 10-20 秒最多 5 个镜头。",
  ].join("\n");
}

function stringifyPlanningValue(value: unknown) {
  return formatPlanningValue(value) || "无";
}

function formatPlanningValue(value: unknown, depth = 0): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return compileCodexPromptText(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    return value
      .map((item) => formatPlanningValue(item, depth + 1))
      .filter(Boolean)
      .map((item) => `${indent}- ${item.replace(/\n/g, `\n${indent}  `)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (isTechnicalPlanningKey(key)) return [];
      const label = planningKeyToChinese(key);
      const formatted = formatPlanningValue(item, depth + 1);
      if (!formatted) return [];
      return [`${indent}${label}：${formatted.replace(/\n/g, `\n${indent}  `)}`];
    });
    return lines.join("\n");
  }
  return "";
}

function isTechnicalPlanningKey(key: string) {
  return /^(id|uuid|contractHash|hash|createdAt|updatedAt)$/i.test(key);
}

function planningKeyToChinese(key: string) {
  const labels: Record<string, string> = {
    projectTitle: "项目标题",
    title: "标题",
    name: "名称",
    characters: "角色",
    scenes: "场景",
    props: "道具",
    visualStyle: "视觉风格",
    cameraLanguage: "镜头语言",
    lockedRules: "锁定规则",
    startState: "开始状态",
    endState: "结束状态",
    carriedHooks: "承接悬念",
    resolvedHooks: "解决悬念",
    nextBridge: "下一段承接",
    timelinePosition: "时间线位置",
    purpose: "本段目的",
    keyEvents: "关键事件",
    emotionalCurve: "情绪曲线",
    turningPoint: "转折点",
    visualFocus: "视觉重点",
    hooks: "伏笔",
    sourceText: "原文范围",
    summary: "摘要",
  };
  return labels[key] || "信息";
}

function normalizeShotCount(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

function isMeaningfulValue(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function minimumShotCountForDuration(value: unknown) {
  const seconds = parseDurationSeconds(value);
  if (!seconds) return 0;
  if (seconds <= 8) return 2;
  if (seconds <= 20) return 4;
  if (seconds <= 60) return 5;
  return 6;
}

function maximumShotCountForDuration(value: unknown) {
  const seconds = parseDurationSeconds(value);
  if (!seconds) return 0;
  if (seconds <= 8) return 3;
  if (seconds <= 20) return 5;
  if (seconds <= 60) return 8;
  return 0;
}

function minimumInputPackShotCount(input: SeasonPackEpisodeInput, context: OutputJsonContext) {
  const minimum = minimumShotCountForDuration(input.duration || context.duration);
  if (!minimum) return 0;
  if (context.lockedSegment || input.segmentContract) {
    return Math.min(minimum, 3);
  }
  return minimum;
}

function validateAnalysisResultShape(result: Record<string, unknown>, context?: OutputJsonContext) {
  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};
  for (const field of REQUIRED_ANALYSIS_RESULT_FIELDS) {
    if (typeof result[field] !== "string" || !String(result[field]).trim()) {
      throw new SeasonPackCodexQueueError(`Season pack episode JSON is missing ${field}`);
    }
  }
  if (typeof result.optimizedScript !== "string" || !result.optimizedScript.trim()) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing optimizedScript");
  }
  if (typeof workflow.fullVideoPrompt !== "string" || !workflow.fullVideoPrompt.trim()) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing workflow.fullVideoPrompt");
  }
  if (hasPoisonedGeneratedText(workflow.fullVideoPrompt)) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON contains invalid undefined/null prompt text");
  }
  if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing storyboard");
  }
  const storyboard = result.storyboard as Record<string, unknown>[];
  const sourceSegment = context?.sourceContext.segments.get(context.episodeIndex);
  const maximumShotCount = maximumShotCountForDuration(result.duration || context?.duration);
  if (maximumShotCount > 0 && storyboard.length > maximumShotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context?.episodeIndex || "output"} has too many storyboard shots: ${storyboard.length} / ${maximumShotCount}`,
    );
  }
  if (sourceSegment?.shotCount && sourceSegment.shotCount <= (maximumShotCount || Number.POSITIVE_INFINITY) && result.storyboard.length !== sourceSegment.shotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context?.episodeIndex || sourceSegment.episodeIndex} storyboard count ${result.storyboard.length} does not match source segment shot count ${sourceSegment.shotCount}`,
    );
  }
  const minimumShotCount = sourceSegment?.shotCount ? 0 : minimumStoryboardShotCount(result, context);
  if (minimumShotCount > 0 && storyboard.length < minimumShotCount) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context?.episodeIndex || "output"} has too few storyboard shots: ${storyboard.length} / ${minimumShotCount}`,
    );
  }
  storyboard.forEach((shot, index) => {
    if (!shot || typeof shot !== "object") {
      throw new SeasonPackCodexQueueError(`Season pack episode JSON storyboard[${index}] must be an object`);
    }
    const record = shot as Record<string, unknown>;
    for (const field of REQUIRED_STORYBOARD_SHOT_FIELDS) {
      if (field === "shotNumber") {
        if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
          throw new SeasonPackCodexQueueError(`Season pack episode JSON is missing storyboard[${index}].${field}`);
        }
        continue;
      }
      if (typeof record[field] !== "string" || !record[field].trim()) {
        throw new SeasonPackCodexQueueError(`Season pack episode JSON is missing storyboard[${index}].${field}`);
      }
    }
  });
  validateStoryboardSpecificity(storyboard, workflow.fullVideoPrompt, context);
}

function minimumStoryboardShotCount(result: Record<string, unknown>, context?: OutputJsonContext) {
  const seconds =
    parseDurationSeconds(result.duration) ||
    parseDurationSeconds(context?.sourceContext.segments.get(context.episodeIndex)?.duration) ||
    parseDurationSeconds(context?.duration);
  if (!seconds) return 0;
  if (seconds <= 8) return 2;
  if (seconds <= 20) return 4;
  if (seconds <= 60) return 5;
  return 6;
}

function validateStoryboardSpecificity(
  storyboard: Record<string, unknown>[],
  fullVideoPrompt: string,
  context?: OutputJsonContext,
) {
  const promptText = String(fullVideoPrompt || "");
  const phraseHits = GENERIC_TEMPLATE_PHRASES.reduce(
    (count, phrase) => count + countOccurrences(promptText, phrase),
    0,
  );
  if (phraseHits >= 2) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context?.episodeIndex || "output"} contains generic template prompt text`,
    );
  }

  const visualSeen = new Map<string, number>();
  storyboard.forEach((shot, index) => {
    const visual = comparableShotText(shot.visual || shot.videoPrompt);
    if (!visual || visual.length < 24) return;
    const previousIndex = visualSeen.get(visual);
    if (previousIndex !== undefined) {
      throw new SeasonPackCodexQueueError(
        `Season pack episode ${context?.episodeIndex || "output"} has duplicated storyboard visuals at shots ${previousIndex + 1} and ${index + 1}`,
      );
    }
    visualSeen.set(visual, index);
  });

  const simpleShotTypes = storyboard.filter((shot) => {
    const shotType = cleanString(shot.shotType);
    return /^(中景|近景|远景|特写|全景|medium shot|close shot|wide shot)$/i.test(shotType);
  }).length;
  if (storyboard.length <= 2 && simpleShotTypes === storyboard.length) {
    throw new SeasonPackCodexQueueError(
      `Season pack episode ${context?.episodeIndex || "output"} is too compressed and template-like`,
    );
  }
}

function hasPoisonedGeneratedText(value: unknown) {
  if (typeof value !== "string") return false;
  return /\b(?:undefined|null)\b/i.test(value);
}

function sanitizeSeasonPlanningPlaceholders(value: unknown, pathParts: string[] = []): unknown {
  if (typeof value === "string") {
    return sanitizePlanningString(value, pathParts[pathParts.length - 1] || "");
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeSeasonPlanningPlaceholders(item, [...pathParts, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeSeasonPlanningPlaceholders(item, [...pathParts, key]),
      ]),
    );
  }
  return value;
}

function sanitizePlanningString(value: string, key: string) {
  const isBridgeKey = /(?:nextBridge|continuityBridge)$/i.test(key);
  const containsBridgeLabel = /(?:nextBridge|continuityBridge)\s*[:=]/i.test(value);
  const containsChineseBridge = /下一段继续\s*[：:]/.test(value);
  if (!isBridgeKey && !containsBridgeLabel && !containsChineseBridge) return sanitizeInternalPromptTokens(value);

  const replacement = "待下一段承接";
  let sanitized = value
    .replace(/((?:nextBridge|continuityBridge)\s*[:=]\s*["']?[^"'\n;；。]*?)\b(?:undefined|null)\b/gi, `$1${replacement}`)
    .replace(/(下一段继续\s*[：:]\s*)\b(?:undefined|null)\b/gi, `$1${replacement}`);

  if (isBridgeKey && hasPoisonedGeneratedText(sanitized)) {
    sanitized = sanitized.replace(/\b(?:undefined|null)\b/gi, replacement);
  }

  return sanitizeInternalPromptTokens(sanitized
    .replace(/[ \t]+([。；;,.，])/g, "$1")
    .replace(/([：:=])\s*([。；;,.，])?\s*$/g, `$1${replacement}`)
    .trim());
}

function countOccurrences(value: string, pattern: string) {
  if (!pattern) return 0;
  return value.split(pattern).length - 1;
}

function comparableShotText(value: unknown) {
  return cleanString(value)
    .replace(/\s+/g, "")
    .replace(/[，。；：、“”‘’《》【】（）()|｜\-—_]/g, "")
    .toLowerCase();
}

function normalizeAnalysisResultShape(result: Record<string, unknown>, context?: OutputJsonContext) {
  const sourceSegment = context?.sourceContext.segments.get(context.episodeIndex);
  const title = normalizeSegmentTitle(cleanString(result.title), context?.episodeIndex || 1)
    || titleFromText(result.optimizedScript)
    || (sourceSegment ? `第${context?.episodeIndex || sourceSegment.episodeIndex}段｜${sourceSegment.title}` : "")
    || `第${context?.episodeIndex || 1}段`;
  const duration = cleanString(result.duration)
    || durationFromText(result.optimizedScript)
    || sourceSegment?.duration
    || normalizeDurationLabel(context?.duration)
    || "15秒";
  const contentType = cleanContentTypeLabel(result.contentType)
    || inferContentTypeFromSource(context?.sourceText || "")
    || normalizeLooseLabel(context?.contentType)
    || "短剧 / 通用";
  const style = cleanString(result.style)
    || inferStyleFromSource(context?.sourceText || "")
    || normalizeLooseLabel(context?.style)
    || "电影级写实";

  result.title = title;
  result.duration = duration;
  result.contentType = contentType;
  result.style = style;

  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};
  const shouldRebuildFullPrompt = !cleanString(workflow.fullVideoPrompt) || hasPoisonedGeneratedText(workflow.fullVideoPrompt);
  workflow.coreTheme = shouldRebuildFullPrompt
    ? `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`
    : cleanString(workflow.coreTheme)
      || `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`;
  workflow.videoParameterLock = shouldRebuildFullPrompt
    ? [
      `总时长：${duration}`,
      "画幅：16:9",
      `风格：${style}`,
      `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
    ].join("\n")
    : cleanString(workflow.videoParameterLock)
      || [
        `总时长：${duration}`,
        "画幅：16:9",
        `风格：${style}`,
        `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
      ].join("\n");
  if (shouldRebuildFullPrompt) {
    workflow.fullVideoPrompt = buildFullVideoPromptFromResult(result, workflow);
  }
  if (!cleanString(workflow.fullNegativePrompt)) {
    workflow.fullNegativePrompt = "不要乱码，不要字幕错误，不要水印，不要畸形肢体，不要过曝画面。";
  }
  result.workflow = workflow;

  if (!Array.isArray(result.storyboard)) return;
  for (const shot of result.storyboard) {
    if (!shot || typeof shot !== "object") continue;
    const record = shot as Record<string, unknown>;
    if (record.dialogue === undefined || record.dialogue === null || (typeof record.dialogue === "string" && !record.dialogue.trim())) {
      record.dialogue = "无";
    }
  }
}

function buildFullVideoPromptFromResult(result: Record<string, unknown>, workflow: Record<string, unknown>) {
  const title = cleanString(result.title) || "未命名视频提示词";
  const duration = cleanString(result.duration) || "15秒";
  const contentType = cleanContentTypeLabel(result.contentType) || "短剧 / 通用";
  const style = cleanString(result.style) || "电影级写实";
  const coreTheme = cleanString(workflow.coreTheme)
    || `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`;
  const technicalParams = cleanString(workflow.videoParameterLock)
    || [
      `总时长：${duration}`,
      "画幅：16:9",
      `风格：${style}`,
      `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
      "运镜原则：按线索推进顺序设计镜头，由空间建立到关键动作，再到人物反应和段尾转场。",
      "光影原则：根据题材控制主色调、明暗层次和真实光源，不使用突兀过曝或廉价特效。",
      "声音原则：以真实环境声、动作声和必要台词为主，不使用喧宾夺主的背景音乐。",
    ].join("\n");
  const shots = Array.isArray(result.storyboard) ? result.storyboard as Record<string, unknown>[] : [];
  const shotLines = shots.map((shot, index) => {
    const shotNumber = typeof shot.shotNumber === "number" ? shot.shotNumber : index + 1;
    return [
      `${cleanString(shot.timeRange) || "-"}｜镜头${shotNumber}｜${cleanString(shot.shotType) || "镜头"}｜${cleanString(shot.scene) || cleanString(shot.shotPurpose) || "剧情推进"}`,
      cleanString(shot.visual) || cleanString(shot.videoPrompt),
      cleanString(shot.composition) ? `机位/构图：${cleanString(shot.composition)}` : "",
      cleanString(shot.cameraMovement) ? `运镜：${cleanString(shot.cameraMovement)}` : "",
      cleanString(shot.lighting) ? `光影：${cleanString(shot.lighting)}` : "",
      `声音：${cleanString(shot.sound) || "真实环境声。"}`,
      `台词：${cleanString(shot.dialogue) || "无"}`,
      `这一镜作用：${cleanString(shot.shotPurpose) || "推动剧情信息，让观众顺着画面线索进入下一镜。"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `核心主题\n\n${coreTheme}`,
    `技术参数\n\n${technicalParams}`,
    `镜头画面 + 时间轴 + 声音 / 台词\n${shotLines}`,
  ].join("\n\n");
}

function parseSeasonSourceContext(sourceText: string): SeasonSourceContext {
  const segments = new Map<number, SeasonSourceSegment>();
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  let current: SeasonSourceSegment | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const segmentMatch = matchSourceSegmentHeading(line);
    if (segmentMatch) {
      current = {
        episodeIndex: segmentMatch.episodeIndex,
        title: cleanSourceTitle(segmentMatch.title),
        shotCount: 0,
      };
      segments.set(current.episodeIndex, current);
      continue;
    }

    const durationMatch = line.match(/^(?:总时长|时长)\s*[：:]\s*(\d+(?:\.\d+)?)\s*秒/);
    if (current && durationMatch) {
      current.duration = `${formatSeconds(Number(durationMatch[1]))}秒`;
      continue;
    }

    const shotMatch = matchSourceShotLine(line);
    if (!shotMatch) continue;
    if (!current) {
      current = {
        episodeIndex: 1,
        title: "第1段",
        shotCount: 0,
      };
      segments.set(current.episodeIndex, current);
    }
    current.shotCount += 1;
    if (shotMatch.endSeconds !== undefined && Number.isFinite(shotMatch.endSeconds)) {
      current.duration = `${formatSeconds(shotMatch.endSeconds)}秒`;
    }
  }

  return {
    contentType: inferContentTypeFromSource(sourceText),
    style: inferStyleFromSource(sourceText),
    segments,
  };
}

function extractSeasonSourceSegmentText(sourceText: string, episodeIndex: number) {
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  const selected: string[] = [];
  let active = false;
  let sawHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = matchSourceSegmentHeading(line);
    if (heading) {
      sawHeading = true;
      if (heading.episodeIndex === episodeIndex) {
        active = true;
        selected.push(rawLine);
        continue;
      }
      if (active) break;
      active = false;
      continue;
    }
    if (active) selected.push(rawLine);
  }

  if (selected.length > 0) return selected.join("\n").trim();
  return sawHeading ? "" : sourceText.trim();
}

function matchSourceSegmentHeading(line: string) {
  const match = line.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*(?:段|集)\s*(?:[｜|:：\-—]\s*)?(.+)?$/);
  if (!match) return null;
  const episodeIndex = parseLocalizedInteger(match[1]);
  if (!episodeIndex) return null;
  const title = cleanSourceTitle(match[2] || `第${episodeIndex}段`);
  return { episodeIndex, title };
}

function matchSourceShotLine(line: string) {
  const timeRangeMatch = line.match(
    /^(\d+(?:\.\d+)?|(?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:s|秒)?\s*[-—~～至到]\s*(\d+(?:\.\d+)?|(?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:s|秒)?\s*(?:[｜|:：\-—]\s*)?镜头\s*[0-9一二三四五六七八九十百]+/,
  );
  if (timeRangeMatch) {
    return { endSeconds: parseTimecodeSeconds(timeRangeMatch[2]) };
  }

  const shotOnlyMatch = line.match(/^镜头\s*[0-9一二三四五六七八九十百]+(?:\s*[｜|:：\-—]|$)/);
  return shotOnlyMatch ? { endSeconds: undefined } : null;
}

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" && !/\bundefined\b/.test(trimmed)
    ? sanitizeInternalPromptTokens(trimmed)
    : "";
}

function cleanContentTypeLabel(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || findInternalPromptToken(raw)) return "";
  const text = cleanString(raw);
  if (/^(?:单段视频提示词结果|视频提示词结果|视频段)$/.test(text)) return "";
  return text;
}

function normalizeLooseLabel(value: unknown) {
  if (findInternalPromptToken(value)) return "";
  const text = cleanString(value);
  if (!text || /^(auto|auto match script tone|short drama \/ general)$/i.test(text)) return "";
  if (/^(?:单段视频提示词结果|视频提示词结果|视频段)$/.test(text)) return "";
  return text;
}

function normalizeDurationLabel(value: unknown) {
  const text = cleanString(value);
  if (!text || /^auto$/i.test(text)) return "";
  if (/^\d+(?:\.\d+)?$/.test(text)) return `${text}秒`;
  return text;
}

function normalizeSegmentTitle(value: string, segmentIndex: number) {
  const text = cleanString(value);
  if (!text) return "";
  const pipeMatch = text.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*(?:集|段)\s*[｜|]\s*(.+)$/);
  if (pipeMatch) return `第${segmentIndex}段｜${cleanSourceTitle(pipeMatch[2])}`;
  const bareMatch = text.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*(?:集|段)$/);
  if (bareMatch) return `第${segmentIndex}段`;
  return cleanSourceEpisodeLabels(text).replace(/^第\s*[0-9一二三四五六七八九十百]+\s*集/, `第${segmentIndex}段`);
}

function titleFromText(value: unknown) {
  const text = cleanString(value);
  const pipeMatch = text.match(/第\s*(\d+)\s*(?:集|段)\s*[｜|]\s*([^。\n]+)/);
  if (pipeMatch) return `第${Number(pipeMatch[1])}段｜${cleanSourceTitle(pipeMatch[2])}`;
  const bracketMatch = text.match(/第\s*(\d+)\s*集\s*[《"]?([^》"\n：:]{2,40})/);
  if (bracketMatch) return `第${Number(bracketMatch[1])}段｜${cleanSourceTitle(bracketMatch[2])}`;
  return "";
}

function durationFromText(value: unknown) {
  const text = cleanString(value);
  const match = text.match(/时长\s*[：:]\s*(\d+(?:\.\d+)?)\s*秒/);
  return match ? `${formatSeconds(Number(match[1]))}秒` : "";
}

function parseDurationSeconds(value: unknown) {
  const text = cleanString(value);
  if (!text || /^auto$/i.test(text)) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|seconds?)/i) || text.match(/^(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : 0;
}

function parseTimecodeSeconds(value: string) {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function parseLocalizedInteger(value: string) {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === "十") return 10;
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const left = text.slice(0, tenIndex);
    const right = text.slice(tenIndex + 1);
    const tens = left ? digits[left] : 1;
    const ones = right ? digits[right] : 0;
    if (tens === undefined || ones === undefined) return 0;
    return tens * 10 + ones;
  }
  return digits[text] || 0;
}

function inferContentTypeFromSource(sourceText: string) {
  if (/刑侦|公安|警局|投案|案/.test(sourceText)) return "短剧 / 刑侦惊悚";
  if (/惊悚|恐怖|旅馆|悬疑/.test(sourceText)) return "短剧 / 悬疑惊悚";
  if (/短剧/.test(sourceText)) return "短剧 / 通用";
  return "";
}

function inferStyleFromSource(sourceText: string) {
  const explicitStyle = sourceText.match(/(?:风格|类型)\s*[：:]\s*([^\n]+)/);
  if (explicitStyle?.[1]) return explicitStyle[1].trim();
  if (/中式现实刑侦惊悚片|悲剧收束/.test(sourceText)) return "中式现实刑侦惊悚片 / 悲剧收束";
  if (/现实主义|现实/.test(sourceText) && /惊悚|悬疑/.test(sourceText)) return "现实主义悬疑惊悚，冷静克制";
  return "";
}

function cleanSourceTitle(value: string) {
  return value
    .replace(/^第\s*[0-9一二三四五六七八九十百]+\s*(?:段|集)\s*(?:[｜|:：\-—]\s*)?/, "")
    .replace(/^["'《「“]+|["'》」”]+$/g, "")
    .trim();
}

function cleanSourceEpisodeLabels(value: string) {
  const text = cleanString(value);
  if (!text) return "";
  return text
    .replace(/原剧本\s*第\s*[0-9一二三四五六七八九十百]+\s*集/g, "原剧本来源段落")
    .replace(/本段为《([^》]+)》第\s*[0-9一二三四五六七八九十百]+\s*集/g, "本段为《$1》来源段落")
    .replace(/《([^》]+)》第\s*[0-9一二三四五六七八九十百]+\s*集/g, "《$1》")
    .replace(/第\s*([0-9一二三四五六七八九十百]+)\s*集(?=\s*[｜|:：\-—])/g, "第$1段")
    .replace(/本集/g, "本段");
}

function normalizeRenderInputScript(value: string) {
  const text = cleanString(value);
  if (!text) return "";
  const normalized = enforceSingleSegmentRendererOutputContract(
    text.replace(/单集渲染输入/g, "单段渲染输入").replace(/普通单集生成/g, "普通单段生成"),
  );
  const prefixed = /单段渲染输入/.test(normalized)
    ? normalized
    : `单段渲染输入：\n${normalized}`;
  return /渲染输出要求：/.test(prefixed)
    ? prefixed
    : `${prefixed}\n渲染输出要求：最终视频提示词 JSON 必须包含完整视频提示词、精简提示词和逐镜头分镜。`;
}

function enforceSingleSegmentRendererOutputContract(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => !isContradictoryRendererOutputLine(line))
    .join("\n")
    .replace(/(?:不要|不得|禁止)[^\n。；;]*workflow\.fullVideoPrompt[^\n。；;]*[。；;]?/gi, "")
    .replace(/\b(?:do not|don't|must not)\s+(?:include|output|contain)[^\n.]*workflow\.fullVideoPrompt[^\n.]*\.?/gi, "")
    .trim();
}

function isContradictoryRendererOutputLine(line: string) {
  return /workflow\.fullVideoPrompt/i.test(line)
    && /\b(?:do not|don't|must not|not contain|not include|not output)\b|(?:不要|不得|禁止)/i.test(line);
}

function appendLockedSegmentPlan(value: string, lockedSegment: LockedSeasonSegment | undefined) {
  if (!lockedSegment) return value;
  const lockedPlanText = [
    "",
    "全局节拍排程锁：",
    `段号：第 ${lockedSegment.segmentIndex} 段`,
    `节拍范围：${lockedSegment.beatStart}-${lockedSegment.beatEnd}`,
    `节拍编号：${lockedSegment.beatIds.join("、")}`,
    `目标时长：${durationLabelFromSeconds(lockedSegment.estimatedDurationSeconds)}，不得超过 15 秒`,
    `镜头数量锁：${lockedSegment.shotCount}`,
    "锁定原文节拍：",
    cleanSourceEpisodeLabels(lockedSegment.sourceText),
    "",
    "渲染规则：当前段只能使用上述锁定节拍范围，不得在渲染阶段把内容移动到其他段。如果无法放入锁定时长，应让质量校验失败，不能自行重新拆段。",
  ].join("\n");
  return value.includes("全局节拍排程锁") ? value : `${compileCodexPromptText(value)}\n${lockedPlanText}`;
}

function appendSegmentContractPlan(value: string, segmentContract: SegmentContract | undefined) {
  if (!segmentContract) return value;
  if (value.includes("段落契约")) return value;
  return `${compileCodexPromptText(value)}\n\n${segmentContractToChineseRenderBlock(segmentContract)}`;
}

function formatSeconds(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function validateCreateInput(input: CreateSeasonPackCodexJobInput) {
  const script = String(input.script || "").trim();
  if (script.length < 5) {
    throw new SeasonPackCodexQueueError("Script must contain at least 5 characters");
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new SeasonPackCodexQueueError("Script is too long for one Codex season pack job");
  }
  const segmentCountMode = input.segmentCountMode === "auto" ? "auto" : "fixed";
  const requestedCount = input.episodeCount;
  if (segmentCountMode === "auto") {
    if (
      requestedCount !== undefined
      && (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_EPISODE_COUNT)
    ) {
      throw new SeasonPackCodexQueueError("Episode count must be between 1 and 30");
    }
    return;
  }
  if (!Number.isInteger(requestedCount) || requestedCount === undefined || requestedCount < 1 || requestedCount > MAX_EPISODE_COUNT) {
    throw new SeasonPackCodexQueueError("Episode count must be between 1 and 30");
  }
}

function normalizeRequestedDuration(duration: string | undefined) {
  const trimmed = duration?.trim();
  return trimmed || "auto";
}

function countCjkCharacters(value: string) {
  return (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
}

function countQuestionMarks(value: string) {
  return (value.match(/\?/g) || []).length;
}

function countReplacementCharacters(value: string) {
  return (value.match(/\ufffd/g) || []).length;
}

function resolveRootDir(options: QueueOptions) {
  return options.rootDir || process.cwd();
}

function jobDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, JOB_DIR);
}

function packRootDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, PACK_DIR);
}

function jobPath(rootDir: string, jobId: string) {
  return path.join(jobDir(rootDir), `${fileSegment(jobId)}.json`);
}

function episodeFileName(index: number) {
  return `episode-${String(index).padStart(3, "0")}.json`;
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
