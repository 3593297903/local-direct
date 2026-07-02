import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type SeasonPackCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type CreateSeasonPackCodexJobInput = {
  projectId?: string;
  script: string;
  episodeCount: number;
  duration?: string;
  contentType?: string;
  style?: string;
  projectMemory?: string;
};

export type SeasonPackEpisodeResult = {
  episodeIndex: number;
  fileName: string;
  result: Record<string, unknown>;
};

export type SeasonPackCodexJobResult = {
  manifest: Record<string, unknown> | null;
  seasonPlan: Record<string, unknown> | null;
  episodes: SeasonPackEpisodeResult[];
};

export type SeasonPackCodexJob = {
  id: string;
  projectId: string | null;
  script: string;
  episodeCount: number;
  duration: string;
  contentType: string;
  style: string;
  projectMemory: string;
  prompt: string;
  status: SeasonPackCodexJobStatus;
  packDir: string;
  episodesDir: string;
  manifestPath: string;
  seasonPlanPath: string;
  result: SeasonPackCodexJobResult | null;
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

const TASK_ROOT = ".tmp-season-pack-codex";
const JOB_DIR = "jobs";
const PACK_DIR = "packs";
const MAX_EPISODE_COUNT = 30;
const MAX_SCRIPT_LENGTH = 50_000;
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

export class SeasonPackCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonPackCodexQueueError";
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
  const contentType = input.contentType || "short drama / general";
  const style = input.style || "auto match script tone";
  const projectMemory = input.projectMemory || "";
  const job: SeasonPackCodexJob = {
    id: jobId,
    projectId: input.projectId || null,
    script: input.script,
    episodeCount: input.episodeCount,
    duration,
    contentType,
    style,
    projectMemory,
    prompt: buildSeasonPackCodexPrompt({
      ...input,
      duration,
      contentType,
      style,
      projectMemory,
    }, { packDir, episodesDir, manifestPath, seasonPlanPath }),
    status: "pending",
    packDir,
    episodesDir,
    manifestPath,
    seasonPlanPath,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await ensureQueueDirs(rootDir);
  await mkdir(episodesDir, { recursive: true });
  await writeJob(rootDir, job);
  return job;
}

export async function getSeasonPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  return syncAndSaveJob(rootDir, job);
}

export async function claimNextSeasonPackCodexJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  const jobs = await listJobs(rootDir);
  const syncedJobs = await Promise.all(jobs.map((job) => syncAndSaveJob(rootDir, job)));
  const recoverableJobs = syncedJobs.map((job) => recoverStaleRunningJob(job, options.runningTimeoutMs));
  await Promise.all(
    recoverableJobs.map((job, index) =>
      job === syncedJobs[index] ? Promise.resolve() : writeJob(rootDir, applyJobStatus(job)),
    ),
  );

  const direction = options.order === "oldest" ? 1 : -1;
  const next = recoverableJobs
    .filter((job) => job.status === "pending")
    .sort((left, right) => direction * (Date.parse(left.createdAt) - Date.parse(right.createdAt)))[0];
  if (!next) return null;

  const now = new Date().toISOString();
  const job: SeasonPackCodexJob = {
    ...next,
    status: "running",
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  await writeJob(rootDir, job);
  return job;
}

export async function completeSeasonPackCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const result = await readSeasonPackResult(job);
  const now = new Date().toISOString();
  const updated: SeasonPackCodexJob = {
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

export async function failSeasonPackCodexJob(
  jobId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = applyJobStatus({
    ...job,
    status: "failed",
    error: message || "Codex season pack generation failed",
    updatedAt: new Date().toISOString(),
  });
  await writeJob(rootDir, updated);
  return updated;
}

function buildSeasonPackCodexPrompt(
  input: Required<Pick<CreateSeasonPackCodexJobInput, "script" | "episodeCount" | "duration" | "contentType" | "style" | "projectMemory">> & {
    projectId?: string;
  },
  paths: { packDir: string; episodesDir: string; manifestPath: string; seasonPlanPath: string },
) {
  const exampleLast = episodeFileName(input.episodeCount);
  return [
    "You are running Local Director season one-shot video prompt generation from a local Codex CLI worker.",
    "Use one long-context pass to understand the complete source script and produce a file pack.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "",
    `You must write exactly ${input.episodeCount} episode JSON files.`,
    `Episode files must be named episode-001.json through ${exampleLast}.`,
    "Each episode file must contain one strict Local Director AnalysisResult JSON object.",
    "Each AnalysisResult must include optimizedScript, workflow.fullVideoPrompt, workflow.fullNegativePrompt, and storyboard.",
    "Every storyboard shot must include shotNumber, timeRange, scene, visual, shotType, composition, cameraMovement, lighting, sound, dialogue, emotion, transition, shotPurpose, firstFramePrompt, videoPrompt, lastFramePrompt, and negativePrompt.",
    "",
    "Write these files as UTF-8 with Node.js fs.writeFileSync. Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    `Pack directory: ${paths.packDir}`,
    `Manifest path: ${paths.manifestPath}`,
    `Season plan path: ${paths.seasonPlanPath}`,
    `Episodes directory: ${paths.episodesDir}`,
    "",
    "Required file pack:",
    "- manifest.json with episodeCount, generatedEpisodes, and status.",
    "- season-plan.json with a compact project bible, characters, scenes, props, and one plan item per episode.",
    `- ${input.episodeCount} episode files in the episodes directory.`,
    "",
    "Generation rules:",
    "- Keep all episodes consistent with the same project bible.",
    "- If Project memory is provided, continue from it and do not reset existing characters, settings, or tone.",
    "- If Project memory is empty, infer a new project bible from the full source script.",
    "- Split the source into the requested number of episodes by meaning and order.",
    "- Do not repeat the full source script inside every episode output.",
    "- Keep each episode self-contained as one saved Local Director episode.",
    "- Use the requested duration rules for each episode.",
    "",
    `Project ID: ${input.projectId || "new project"}`,
    `Episode count: ${input.episodeCount}`,
    `Duration: ${input.duration}`,
    `Content type: ${input.contentType}`,
    `Style: ${input.style}`,
    "",
    "Project memory:",
    input.projectMemory || "(none)",
    "",
    "Full source script:",
    input.script,
    "",
    "Completion requirements:",
    "1. Create all directories if they do not exist.",
    "2. Write manifest.json, season-plan.json, and every episode JSON file.",
    "3. Read every JSON file back and confirm it parses.",
    "4. Confirm Chinese characters are preserved, not replaced by question marks.",
    "5. Final reply must be exactly one line: DONE.",
  ].join("\n");
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

  return {
    ...job,
    status: "completed" as const,
    result: await readSeasonPackResult(job),
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
    return JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as SeasonPackCodexJob;
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
  for (let episodeIndex = 1; episodeIndex <= job.episodeCount; episodeIndex += 1) {
    const fileName = episodeFileName(episodeIndex);
    const filePath = path.join(job.episodesDir, fileName);
    const result = await readOutputJson(filePath, job.script);
    episodes.push({ episodeIndex, fileName, result });
  }

  return {
    manifest: await readOptionalJson(job.manifestPath),
    seasonPlan: await readOptionalJson(job.seasonPlanPath),
    episodes,
  };
}

async function readOutputJson(filePath: string, sourceText = "") {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new SeasonPackCodexQueueError(`Season pack output file is empty: ${filePath}`);
    }
    const result = JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))) as Record<string, unknown>;
    validateAnalysisResultShape(result);
    validateEncodingQuality(result, sourceText);
    return result;
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

function validateAnalysisResultShape(result: Record<string, unknown>) {
  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};
  if (typeof result.optimizedScript !== "string" || !result.optimizedScript.trim()) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing optimizedScript");
  }
  if (typeof workflow.fullVideoPrompt !== "string" || !workflow.fullVideoPrompt.trim()) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing workflow.fullVideoPrompt");
  }
  if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
    throw new SeasonPackCodexQueueError("Season pack episode JSON is missing storyboard");
  }
  result.storyboard.forEach((shot, index) => {
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
}

function validateCreateInput(input: CreateSeasonPackCodexJobInput) {
  const script = String(input.script || "").trim();
  if (script.length < 5) {
    throw new SeasonPackCodexQueueError("Script must contain at least 5 characters");
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new SeasonPackCodexQueueError("Script is too long for one Codex season pack job");
  }
  if (!Number.isInteger(input.episodeCount) || input.episodeCount < 1 || input.episodeCount > MAX_EPISODE_COUNT) {
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
