import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type VideoPromptCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type CreateVideoPromptCodexJobInput = {
  projectId?: string;
  versionId?: string;
  script: string;
  contentType?: string;
  style?: string;
  duration?: string;
  projectMemory?: string;
};

export type VideoPromptCodexJob = {
  id: string;
  projectId: string | null;
  versionId: string | null;
  script: string;
  contentType: string;
  style: string;
  duration: string;
  projectMemory: string;
  prompt: string;
  status: VideoPromptCodexJobStatus;
  outputFileName: string;
  outputPath: string;
  result: Record<string, unknown> | null;
  error: string | null;
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
};

const TASK_ROOT = ".tmp-video-prompt-codex";
const JOB_DIR = "jobs";
const RESULT_DIR = "results";
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

export class VideoPromptCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoPromptCodexQueueError";
  }
}

export async function createVideoPromptCodexJob(
  input: CreateVideoPromptCodexJobInput,
  options: QueueOptions = {},
) {
  validateCreateInput(input);

  const rootDir = resolveRootDir(options);
  const now = new Date().toISOString();
  const jobId = createId("video-prompt-job");
  const outputFileName = `${jobId}.json`;
  const outputPath = path.join(resultDir(rootDir), outputFileName);
  const requestedDuration = normalizeRequestedDuration(input.duration);
  const projectMemory = input.projectMemory || "";
  const normalizedInput = { ...input, duration: requestedDuration, projectMemory };
  const job: VideoPromptCodexJob = {
    id: jobId,
    projectId: input.projectId || null,
    versionId: input.versionId || null,
    script: input.script,
    contentType: input.contentType || "短剧 / 通用",
    style: input.style || "自动匹配文案气质",
    duration: requestedDuration,
    projectMemory,
    prompt: buildVideoPromptCodexPrompt(normalizedInput, outputPath),
    status: "pending",
    outputFileName,
    outputPath,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await ensureQueueDirs(rootDir);
  await writeJob(rootDir, job);
  return job;
}

function normalizeRequestedDuration(duration: string | undefined) {
  const trimmed = duration?.trim();
  return trimmed || "auto";
}

export async function getVideoPromptCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  return syncAndSaveJob(rootDir, job);
}

export async function claimNextVideoPromptCodexJob(options: ClaimOptions = {}) {
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
  const job: VideoPromptCodexJob = {
    ...next,
    status: "running",
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  await writeJob(rootDir, job);
  return job;
}

export async function completeVideoPromptCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const result = await readVideoPromptOutputJson(job.outputPath, job.script);
  const now = new Date().toISOString();
  const updated: VideoPromptCodexJob = {
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

export async function failVideoPromptCodexJob(
  jobId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = applyJobStatus({
    ...job,
    status: "failed",
    error: message || "Codex video prompt generation failed",
    updatedAt: new Date().toISOString(),
  });
  await writeJob(rootDir, updated);
  return updated;
}

function buildVideoPromptCodexPrompt(input: CreateVideoPromptCodexJobInput, outputPath: string) {
  const requestedDuration = normalizeRequestedDuration(input.duration);
  const durationMode = requestedDuration.toLowerCase() === "auto" ? "auto" : "fixed";
  return [
    "You are handling a Local Director local video prompt generation task.",
    "",
    "Generate strict JSON only. The JSON must match the Local Director AnalysisResult contract.",
    "Do not open a browser. Do not ask the user to copy or paste. Do not call network providers.",
    "",
    "Required top-level fields:",
    "- title",
    "- contentType",
    "- duration",
    "- style",
    "- diagnosis",
    "- optimizedScript",
    "- workflow.fullVideoPrompt",
    "- workflow.fullNegativePrompt",
    "- workflow.concisePrompt",
    "- storyboard",
    "",
    "Storyboard requirements:",
    "- Create a coherent shot list for the requested duration.",
    "- For dense 13-15 second requests, return 4-5 shots unless the script clearly needs fewer.",
    "- Every shot must include shotNumber, timeRange, scene, visual, shotType, composition, cameraMovement, lighting, sound, dialogue, emotion, transition, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt.",
    "- composition must describe camera position and frame composition.",
    "- lighting must describe film lighting and color tone.",
    "- sound must describe ambience, effects, or music.",
    "- dialogue must contain the line spoken in the shot, or the exact string \"无\" when there is no dialogue.",
    "- shotPurpose must explain why this shot exists in the sequence.",
    "",
    "Duration rules:",
    `- Duration mode: ${durationMode}`,
    "- If Duration mode is auto, first honor explicit duration written in Script, such as 总时长：9秒, 视频时长：12秒, or 9 秒视频.",
    "- If Duration mode is auto and Script has no explicit duration, infer the best duration from the script rhythm, between 4 and 15 seconds.",
    "- If Duration mode is fixed, treat Duration as the upper budget and keep the final total within that budget.",
    "- Always output the resolved duration in the JSON duration field, not the word auto.",
    "",
    "File writing requirements:",
    "- Write the JSON file as UTF-8.",
    "- Prefer Node.js fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), \"utf8\").",
    "- Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    "- After writing, read the file back as UTF-8 and confirm Chinese characters are preserved, not replaced by question marks.",
    "",
    `Script: ${input.script}`,
    `Content type: ${input.contentType || "短剧 / 通用"}`,
    `Style: ${input.style || "自动匹配文案气质"}`,
    `Duration: ${requestedDuration}`,
    "",
    "Project memory / continuity context:",
    input.projectMemory || "(none)",
    `Output path: ${outputPath}`,
    "",
    "Completion requirements:",
    "1. Write the final JSON object to the exact output path.",
    "2. Create the output directory first if it does not exist.",
    "3. Ensure the file is valid JSON and includes optimizedScript, workflow.fullVideoPrompt, and workflow.concisePrompt.",
    "4. Reply with one line only: DONE.",
  ].join("\n");
}

async function syncAndSaveJob(rootDir: string, job: VideoPromptCodexJob) {
  const synced = await syncJobFromOutputFile(job);
  const finalized = applyJobStatus(normalizeCompletedJobResult(synced));
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    await writeJob(rootDir, finalized);
  }
  return finalized;
}

async function syncJobFromOutputFile(job: VideoPromptCodexJob) {
  if (job.status === "completed") return job;
  if (!(await isValidOutputJson(job.outputPath, job.script))) return job;

  return {
    ...job,
    status: "completed" as const,
    result: await readVideoPromptOutputJson(job.outputPath, job.script),
    error: null,
    completedAt: job.completedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function recoverStaleRunningJob(job: VideoPromptCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0 || job.status !== "running") return job;

  const startedAtMs = Date.parse(job.startedAt || job.updatedAt || job.createdAt);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < runningTimeoutMs) return job;

  return {
    ...job,
    status: "pending" as const,
    startedAt: undefined,
    error: "Previous Codex run exceeded the video prompt task timeout and was returned to the queue",
    updatedAt: new Date().toISOString(),
  };
}

function applyJobStatus(job: VideoPromptCodexJob): VideoPromptCodexJob {
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

async function readJob(rootDir: string, jobId: string): Promise<VideoPromptCodexJob> {
  try {
    return JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as VideoPromptCodexJob;
  } catch (error) {
    throw new VideoPromptCodexQueueError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "Video prompt Codex job not found" : "Video prompt Codex job could not be read",
    );
  }
}

async function writeJob(rootDir: string, job: VideoPromptCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
  await mkdir(resultDir(rootDir), { recursive: true });
}

export async function readVideoPromptOutputJson(filePath: string, sourceText = "") {
  try {
    const result = normalizeAnalysisResultShape(JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))) as Record<string, unknown>);
    validateAnalysisResultShape(result);
    validateVideoPromptEncodingQuality(result, sourceText);
    return result;
  } catch (error) {
    throw new VideoPromptCodexQueueError(
      error instanceof VideoPromptCodexQueueError
        ? error.message
        : `Codex did not produce valid video prompt JSON: ${filePath}`,
    );
  }
}

function normalizeCompletedJobResult(job: VideoPromptCodexJob): VideoPromptCodexJob {
  if (job.status !== "completed" || !job.result) return job;

  const normalizedResult = normalizeAnalysisResultShape(
    JSON.parse(JSON.stringify(job.result)) as Record<string, unknown>,
  );
  if (JSON.stringify(normalizedResult) === JSON.stringify(job.result)) return job;
  return { ...job, result: normalizedResult };
}

function normalizeAnalysisResultShape(result: Record<string, unknown>) {
  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};

  const optimizedScript = cleanString(result.optimizedScript);
  const fullVideoPrompt = cleanString(workflow.fullVideoPrompt);
  const fallbackPrompt = optimizedScript || fullVideoPrompt;

  result.workflow = workflow;

  if (!cleanString(workflow.concisePrompt)) {
    workflow.concisePrompt = fallbackPrompt;
  }
  if (!cleanString(workflow.sourceAnalysis)) {
    workflow.sourceAnalysis = cleanString(result.title) || fallbackPrompt;
  }
  if (!cleanString(workflow.screenplay)) {
    workflow.screenplay = fallbackPrompt;
  }
  if (!cleanString(workflow.filmScript)) {
    workflow.filmScript = fullVideoPrompt || optimizedScript;
  }
  if (!cleanString(workflow.fullNegativePrompt)) {
    workflow.fullNegativePrompt = "不要乱码，不要字幕错误，不要水印，不要畸形肢体，不要过曝画面。";
  }
  if (!Array.isArray(result.diagnosis)) {
    result.diagnosis = [];
  }
  if (!Array.isArray(result.recommendedItems)) {
    result.recommendedItems = workflow.concisePrompt ? [workflow.concisePrompt] : [];
  }
  if (!Array.isArray(result.editingNotes)) {
    result.editingNotes = [];
  }

  return result;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stripJsonBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function validateVideoPromptEncodingQuality(result: Record<string, unknown>, sourceText: string) {
  const sourceCjkCount = countCjkCharacters(sourceText);
  if (sourceCjkCount < 3) return;

  const serialized = JSON.stringify(result);
  const questionMarkCount = countQuestionMarks(serialized);
  const replacementCharCount = countReplacementCharacters(serialized);
  const resultCjkCount = countCjkCharacters(serialized);

  if (replacementCharCount > 0) {
    throw new VideoPromptCodexQueueError("Video prompt JSON encoding appears damaged: replacement characters were found");
  }
  if (questionMarkCount >= 20 && questionMarkCount > Math.max(60, resultCjkCount * 2)) {
    throw new VideoPromptCodexQueueError("Video prompt JSON encoding appears damaged: excessive question marks in Chinese output");
  }
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

async function isValidOutputJson(filePath: string, sourceText = "") {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) return false;
    await readVideoPromptOutputJson(filePath, sourceText);
    return true;
  } catch {
    return false;
  }
}

function validateAnalysisResultShape(result: Record<string, unknown>) {
  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};
  if (typeof result.optimizedScript !== "string" || !result.optimizedScript.trim()) {
    throw new VideoPromptCodexQueueError("Video prompt JSON is missing optimizedScript");
  }
  if (typeof workflow.fullVideoPrompt !== "string" || !workflow.fullVideoPrompt.trim()) {
    throw new VideoPromptCodexQueueError("Video prompt JSON is missing workflow.fullVideoPrompt");
  }
  if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
    throw new VideoPromptCodexQueueError("Video prompt JSON is missing storyboard");
  }
  result.storyboard.forEach((shot, index) => {
    if (!shot || typeof shot !== "object") {
      throw new VideoPromptCodexQueueError(`Video prompt JSON storyboard[${index}] must be an object`);
    }
    const record = shot as Record<string, unknown>;
    for (const field of REQUIRED_STORYBOARD_SHOT_FIELDS) {
      if (field === "shotNumber") {
        if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
          throw new VideoPromptCodexQueueError(`Video prompt JSON is missing storyboard[${index}].${field}`);
        }
        continue;
      }
      if (typeof record[field] !== "string" || !record[field].trim()) {
        throw new VideoPromptCodexQueueError(`Video prompt JSON is missing storyboard[${index}].${field}`);
      }
    }
  });
}

function validateCreateInput(input: CreateVideoPromptCodexJobInput) {
  const script = String(input.script || "").trim();
  if (script.length < 5) {
    throw new VideoPromptCodexQueueError("Script must contain at least 5 characters");
  }
  if (script.length > 50_000) {
    throw new VideoPromptCodexQueueError("Script is too long for one Codex video prompt job");
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

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
