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
    "You are running Local Director season planning from a local Codex CLI worker.",
    "Use one long-context pass to understand the complete source script and produce a planning file pack.",
    "Important: do NOT generate final video prompts here. Do NOT generate AnalysisResult JSON here.",
    "This task only creates Story Bible, Segment Chain, and per-segment input packs for the normal single-segment renderer.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "",
    `You must write exactly ${input.episodeCount} segment JSON files.`,
    `Segment files keep the compatibility filename pattern episode-001.json through ${exampleLast}.`,
    "Each file must contain one strict Segment Input Pack JSON object, not a final prompt result.",
    "For compatibility this object is also called an Episode Input Pack in older code, but user-facing text must say segment / 段.",
    "Every Segment Input Pack must include: episodeIndex, title, sourceText, duration, contentType, style, storyBible, episodeChain, blueprint, shotCount, and renderInputScript.",
    "Do not include workflow.fullVideoPrompt. Do not include storyboard. The downstream single-episode renderer will create those.",
    "",
    "Write these files as UTF-8 with Node.js fs.writeFileSync. Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    `Pack directory: ${paths.packDir}`,
    `Manifest path: ${paths.manifestPath}`,
    `Season plan path: ${paths.seasonPlanPath}`,
    `Episodes directory: ${paths.episodesDir}`,
    "",
    "Required file pack:",
    "- manifest.json with episodeCount, generatedEpisodes, and status.",
    "- season-plan.json with storyBible, episodeChain, characters, scenes, props, visualStyle, cameraLanguage, lockedRules, and one plan item per segment.",
    `- ${input.episodeCount} segment files in the episodes directory.`,
    "",
    "Planning rules:",
    "- Build one stable Story Bible from the full source and Project memory.",
    "- Build one Segment Chain covering every requested segment: startState, endState, carriedHooks, resolvedHooks, nextBridge, timelinePosition.",
    "- Keep all segments consistent with the same Story Bible and ID references.",
    "- If Project memory is provided, continue from it and do not reset existing characters, settings, or tone.",
    "- If Project memory is empty, infer a new project bible from the full source script.",
    "- Split the source into the requested number of video segments by meaning and order. These are Local Director segments, not story episodes.",
    "- If the source script already contains explicit segment headings such as 第1段 / 第2段, preserve that segment count and order.",
    "- If the source contains labels such as 原剧本第二集 / 第三集, keep them only as internal source metadata and never write them into final title, sourceText, or renderInputScript.",
    "- If a source segment contains explicit 镜头 lines or time-range shot lines such as 0s-4s｜镜头1 or 00:00-00:04｜镜头1, use that count only when it fits the duration density rules below.",
    "- Shot density is locked: 15 秒默认 4-5 镜头; for 10-20 seconds, shotCount must be 4 or 5 unless the user explicitly says 密集镜头版. Do not pack 7-8 shots into a 14-15 second segment.",
    "- If the source does not contain explicit shot lines, infer shotCount by duration: <=8 seconds needs 2 shots, 10-20 seconds needs 4-5 shots, 20-60 seconds needs 5-8 shots, and longer segments need more concrete beats.",
    "- Preserve concrete source locations, actions, objects, dialogue, and character beats in sourceText and blueprint.",
    "- The segment title should be 第N段｜source segment title when a segment title exists.",
    "- The segment duration should match the source segment end time when explicit shot time ranges exist, otherwise follow the requested duration.",
    "- contentType and style must be concrete Chinese text inferred from the full source and project memory; never leave them blank.",
    "- renderInputScript is the exact script that will be sent to the normal single-segment renderer. It must be compact but complete.",
    "- renderInputScript must include: Story Bible summary, Segment Chain item, Segment Blueprint, original sourceText, shotCount lock, style lock, continuity rules, and a clear instruction to generate a full Local Director single-segment AnalysisResult.",
    "- renderInputScript must say 第 N 段, 本段, and 单集渲染输入. It must not say 第 N 集 or 本集.",
    "- renderInputScript must not contain final workflow.fullVideoPrompt or final storyboard JSON.",
    "",
    `Project ID: ${input.projectId || "new project"}`,
    `Segment count: ${input.episodeCount}`,
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
    "2. Write manifest.json, season-plan.json, and every episode input-pack JSON file.",
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
  const sourceContext = parseSeasonSourceContext(job.script);
  for (let episodeIndex = 1; episodeIndex <= job.episodeCount; episodeIndex += 1) {
    const fileName = episodeFileName(episodeIndex);
    const filePath = path.join(job.episodesDir, fileName);
    const input = await readOutputJson(filePath, {
      sourceText: job.script,
      episodeIndex,
      episodeCount: job.episodeCount,
      duration: job.duration,
      contentType: job.contentType,
      style: job.style,
      sourceContext,
    });
    episodes.push({ episodeIndex, fileName, input });
  }

  return {
    manifest: await readOptionalJson(job.manifestPath),
    seasonPlan: await readOptionalJson(job.seasonPlanPath),
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
      contentType: "short drama / general",
      style: "auto match script tone",
      sourceContext: parseSeasonSourceContext(context),
    }
    : context;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new SeasonPackCodexQueueError(`Season pack output file is empty: ${filePath}`);
    }
    const result = JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))) as Record<string, unknown>;
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
  const title = normalizeSegmentTitle(cleanString(result.title), context.episodeIndex)
    || (sourceSegment ? `第${context.episodeIndex}段｜${sourceSegment.title}` : "")
    || `第${context.episodeIndex}段`;
  const duration = cleanString(result.duration)
    || sourceSegment?.duration
    || normalizeDurationLabel(context.duration)
    || "15秒";
  const contentType = cleanString(result.contentType)
    || inferContentTypeFromSource(context.sourceText)
    || normalizeLooseLabel(context.contentType)
    || "短剧 / 通用";
  const style = cleanString(result.style)
    || inferStyleFromSource(context.sourceText)
    || normalizeLooseLabel(context.style)
    || "电影级写实";
  const sourceText = cleanSourceEpisodeLabels(cleanString(result.sourceText)
    || extractSeasonSourceSegmentText(context.sourceText, context.episodeIndex)
    || context.sourceText);
  const shotCount = normalizeShotCount(result.shotCount)
    || sourceSegment?.shotCount
    || minimumShotCountForDuration(duration)
    || minimumShotCountForDuration(context.duration)
    || 4;
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
  };
  partial.renderInputScript = normalizeRenderInputScript(cleanSourceEpisodeLabels(cleanString(result.renderInputScript) || buildEpisodeRenderInputScript(partial)));
  return partial;
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
  const minimumShotCount = sourceSegment?.shotCount ? 0 : minimumShotCountForDuration(input.duration || context.duration);
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
    `你正在为 Local Director 生成第 ${input.episodeIndex} 段的单集视频提示词。`,
    "",
    "单集渲染输入：必须按普通单集生成的质量和结构输出完整 AnalysisResult。",
    "不要输出摘要版，不要压缩镜头，不要省略镜头字段。",
    "最终标题、核心主题和完整视频提示词都必须使用“段”，不要写“第N集”或“本集”。",
    "",
    `标题：${input.title}`,
    `时长：${input.duration}`,
    `内容类型：${input.contentType}`,
    `风格：${input.style}`,
    `镜头数量锁：${input.shotCount} 个镜头。最终 storyboard 必须严格等于这个数量。`,
    "",
    "Story Bible / 项目固定记忆：",
    stringifyPlanningValue(input.storyBible),
    "",
    "Segment Chain / 本段前后承接：",
    stringifyPlanningValue(input.episodeChain),
    "",
    "Segment Blueprint / 本段结构规划：",
    stringifyPlanningValue(input.blueprint),
    "",
    "本段原文案：",
    input.sourceText,
    "",
    "生成要求：",
    "1. 使用和单集生成完全相同的质量标准，输出完整视频生成提示词和逐镜头分镜。",
    "2. 保留本段原文案的关键事件、人物关系、时间线、道具线索和情绪推进。",
    "3. 读取 Story Bible 和 Segment Chain 保持跨段连续性，但不要提前泄露后续内容。",
    "4. 每个镜头必须包含时间范围、景别、机位/构图、运镜、画面、光影、声音/台词、情绪、转场、镜头目的、firstFramePrompt、videoPrompt、lastFramePrompt、negativePrompt。",
    "5. 15 秒默认 4-5 镜头；除非用户明确要求密集镜头版，否则 10-20 秒最多 5 个镜头。",
  ].join("\n");
}

function stringifyPlanningValue(value: unknown) {
  if (typeof value === "string") return value.trim() || "{}";
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
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
  const contentType = cleanString(result.contentType)
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
  const contentType = cleanString(result.contentType) || "短剧 / 通用";
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
  return trimmed && trimmed !== "undefined" && trimmed !== "null" && !/\bundefined\b/.test(trimmed) ? trimmed : "";
}

function normalizeLooseLabel(value: unknown) {
  const text = cleanString(value);
  if (!text || /^(auto|auto match script tone|short drama \/ general)$/i.test(text)) return "";
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
  const normalized = text.replace(/单段渲染输入/g, "单集渲染输入");
  return /单集渲染输入/.test(normalized)
    ? normalized
    : `单集渲染输入：\n${normalized}`;
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
