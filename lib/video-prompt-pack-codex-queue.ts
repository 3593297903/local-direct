import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readVideoPromptOutputJson } from "./video-prompt-codex-queue";

export type VideoPromptPackCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type VideoPromptPackSegmentInput = {
  episodeIndex: number;
  title: string;
  script: string;
  renderInputScript: string;
  duration: string;
  shotCount?: number;
};

export type CreateVideoPromptPackCodexJobInput = {
  projectId?: string;
  mode?: VideoPromptPackCodexMode;
  segments: VideoPromptPackSegmentInput[];
};

export type VideoPromptPackSegmentTask = VideoPromptPackSegmentInput & {
  outputFileName: string;
  outputPath: string;
};

export type VideoPromptPackCodexResult = {
  segments: Array<{
    episodeIndex: number;
    outputPath: string;
    result: Record<string, unknown>;
  }>;
};

export type VideoPromptPackCodexJob = {
  id: string;
  projectId: string | null;
  mode: VideoPromptPackCodexMode;
  segments: VideoPromptPackSegmentTask[];
  prompt: string;
  status: VideoPromptPackCodexJobStatus;
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
};

const TASK_ROOT = ".tmp-video-prompt-pack-codex";
const JOB_DIR = "jobs";
const RESULT_DIR = "results";
const MAX_PACK_SEGMENTS = 4;

export class VideoPromptPackCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoPromptPackCodexQueueError";
  }
}

export async function createVideoPromptPackCodexJob(
  input: CreateVideoPromptPackCodexJobInput,
  options: QueueOptions = {},
) {
  validateCreateInput(input);

  const rootDir = resolveRootDir(options);
  const now = new Date().toISOString();
  const jobId = createId("video-prompt-pack-job");
  const segments = input.segments.map((segment) => {
    const outputFileName = episodeFileName(segment.episodeIndex);
    return {
      ...segment,
      outputFileName,
      outputPath: path.join(resultDir(rootDir), fileSegment(jobId), outputFileName),
    };
  });
  const mode = input.mode === "standard" ? "standard" : "strictUtf8";
  const job: VideoPromptPackCodexJob = {
    id: jobId,
    projectId: input.projectId || null,
    mode,
    segments,
    prompt: buildVideoPromptPackCodexPrompt(jobId, segments, mode),
    status: "pending",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await ensureQueueDirs(rootDir);
  await writeJob(rootDir, job);
  return job;
}

export async function getVideoPromptPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  return syncAndSaveJob(rootDir, job);
}

export async function claimNextVideoPromptPackCodexJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  const jobs = await listJobs(rootDir);
  const syncedJobs = await Promise.all(jobs.map((job) => syncAndSaveJob(rootDir, job)));
  const recoverableJobs = syncedJobs.map((job) => recoverStaleRunningJob(job, options.runningTimeoutMs));
  await Promise.all(
    recoverableJobs.map((job, index) =>
      job === syncedJobs[index] ? Promise.resolve() : writeJob(rootDir, applyJobStatus(job)),
    ),
  );

  const order = options.order === "newest" ? "newest" : "oldest";
  const direction = order === "oldest" ? 1 : -1;
  const next = recoverableJobs
    .filter((job) => job.status === "pending")
    .sort((left, right) => direction * (Date.parse(left.createdAt) - Date.parse(right.createdAt)))[0];
  if (!next) return null;

  const now = new Date().toISOString();
  const job: VideoPromptPackCodexJob = {
    ...next,
    status: "running",
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  await writeJob(rootDir, job);
  return job;
}

export async function completeVideoPromptPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
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
  await writeJob(rootDir, updated);
  return updated;
}

export async function failVideoPromptPackCodexJob(
  jobId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = applyJobStatus({
    ...job,
    status: "failed",
    error: message || "Codex video prompt render pack generation failed",
    updatedAt: new Date().toISOString(),
  });
  await writeJob(rootDir, updated);
  return updated;
}

function buildVideoPromptPackCodexPrompt(
  jobId: string,
  segments: VideoPromptPackSegmentTask[],
  mode: VideoPromptPackCodexMode,
) {
  const segmentInstructions = segments.flatMap((segment) => [
    `Segment ${segment.episodeIndex}: ${segment.title}`,
    `Duration: ${segment.duration}`,
    `Shot count lock: ${segment.shotCount || "use render script lock"}`,
    `Output path: ${segment.outputPath}`,
    "Render script:",
    segment.renderInputScript,
    "",
  ]);
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
    "A Render Pack reduces CLI startup overhead, but every segment must still be rendered as a complete independent single-segment AnalysisResult JSON.",
    "Do not open a browser. Do not ask the user to copy or paste. Do not call network providers.",
    "",
    "Hard quality rules:",
    "- Write one separate JSON file per segment to the exact output path shown below.",
    "- Each JSON must be a complete Local Director AnalysisResult, not a summary and not a combined array.",
    "- Each JSON must include title, contentType, duration, style, diagnosis, optimizedScript, workflow.fullVideoPrompt, workflow.fullNegativePrompt, workflow.concisePrompt, and storyboard.",
    "- Every storyboard shot must include shotNumber, timeRange, scene, visual, shotType, composition, cameraMovement, lighting, sound, dialogue, emotion, transition, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt.",
    "- Keep single-segment quality: a 4-shot segment should usually have workflow.fullVideoPrompt with at least 1400 meaningful Chinese characters; 3-shot segments should usually have at least 1100.",
    "- Do not make thin shots. visual, composition, lighting, sound, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt must be concrete, shootable text instead of short labels.",
    "- videoPrompt must describe the full moving image for that shot with action, space, camera behavior, light, sound, emotion, and continuity. Do not output one-sentence summaries.",
    "- Do not use 同上, 如上, 略, 参考上一段, continue as above, or any placeholder that depends on another segment.",
    "- If there is no spoken line, dialogue must be a concrete no-dialogue value such as \"无\" or \"none\".",
    "- Preserve the specific render script, shot count lock, Story Bible continuity, and source events for each segment.",
    "",
    "File writing requirements:",
    "- Write all JSON files as UTF-8.",
    "- Prefer Node.js fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), \"utf8\").",
    "- Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    ...strictUtf8Instructions,
    "",
    `Render Pack ID: ${jobId}`,
    `Pack size: ${segments.length}`,
    "",
    "Segments:",
    ...segmentInstructions,
    "Completion requirements:",
    "1. Create every output directory if it does not exist.",
    "2. Write every segment JSON file to the exact output path.",
    "3. Read every JSON file back and confirm it parses.",
    "4. Final reply must be exactly one line: DONE.",
  ].join("\n");
}

async function syncAndSaveJob(rootDir: string, job: VideoPromptPackCodexJob) {
  const synced = await syncJobFromOutputFiles(job);
  const finalized = applyJobStatus(synced);
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    await writeJob(rootDir, finalized);
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

function recoverStaleRunningJob(job: VideoPromptPackCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0 || job.status !== "running") return job;

  const startedAtMs = Date.parse(job.startedAt || job.updatedAt || job.createdAt);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < runningTimeoutMs) return job;

  return {
    ...job,
    status: "pending" as const,
    startedAt: undefined,
    error: "Previous Codex run exceeded the video prompt render pack task timeout and was returned to the queue",
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
    job.segments.map(async (segment) => ({
      episodeIndex: segment.episodeIndex,
      outputPath: segment.outputPath,
      result: await readVideoPromptOutputJson(segment.outputPath, `${segment.script}\n${segment.renderInputScript}`),
    })),
  );
  return { segments: segments.sort((left, right) => left.episodeIndex - right.episodeIndex) };
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

async function readJob(rootDir: string, jobId: string): Promise<VideoPromptPackCodexJob> {
  try {
    const job = JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as VideoPromptPackCodexJob;
    return {
      ...job,
      mode: job.mode === "strictUtf8" ? "strictUtf8" : "standard",
    };
  } catch (error) {
    throw new VideoPromptPackCodexQueueError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Video prompt render pack Codex job not found"
        : "Video prompt render pack Codex job could not be read",
    );
  }
}

async function writeJob(rootDir: string, job: VideoPromptPackCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
  await mkdir(resultDir(rootDir), { recursive: true });
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
  return options.rootDir || process.cwd();
}

function jobDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, JOB_DIR);
}

function resultDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, RESULT_DIR);
}

function jobPath(rootDir: string, jobId: string) {
  return path.join(jobDir(rootDir), `${fileSegment(jobId)}.json`);
}

function episodeFileName(episodeIndex: number) {
  return `episode-${String(episodeIndex).padStart(3, "0")}.json`;
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
