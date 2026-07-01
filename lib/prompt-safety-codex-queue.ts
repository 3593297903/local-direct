import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type PromptSafetyCodexJobStatus = "pending" | "running" | "completed" | "failed";

export type PromptSafetyFinding = {
  field: string;
  shotNumber?: number;
  original: string;
  reason: string;
  replacement?: string;
  severity?: "low" | "medium" | "high";
};

export type PromptSafetyPatch = {
  path: string;
  original: string;
  replacement: string;
  riskType?: string;
  strategy?: string;
  reason?: string;
  severity?: "low" | "medium" | "high";
};

export type PromptSafetyOptimizationResult = {
  targetModel: string;
  status: "PASSED" | "OPTIMIZED" | "BLOCKED_NEEDS_USER_EDIT";
  riskLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  findings: PromptSafetyFinding[];
  changeSummary: string[];
  patches: PromptSafetyPatch[];
  optimizedResult: Record<string, unknown>;
};

type PromptSafetyCodexOutput = Omit<PromptSafetyOptimizationResult, "optimizedResult" | "patches"> & {
  patches?: PromptSafetyPatch[];
  optimizedResult?: Record<string, unknown>;
};

export type CreatePromptSafetyCodexJobInput = {
  projectId?: string;
  versionId?: string;
  targetModel?: string;
  promptText: string;
  sourceResult: Record<string, unknown>;
};

export type PromptSafetyCodexJob = {
  id: string;
  projectId: string | null;
  versionId: string | null;
  targetModel: string;
  promptText: string;
  sourceResult: Record<string, unknown>;
  prompt: string;
  status: PromptSafetyCodexJobStatus;
  outputFileName: string;
  outputPath: string;
  result: PromptSafetyOptimizationResult | null;
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

const TASK_ROOT = ".tmp-prompt-safety-codex";
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

const PROMPT_SAFETY_LEXICAL_REPLACEMENTS = [
  ["被城管打伤", "被管理员伤到"],
  ["执法现场", "管理现场"],
  ["赶她走", "劝她走"],
  ["打伤", "伤到"],
  ["城管", "管理员"],
] as const;
const PROMPT_SAFETY_CJK_REPLACEMENT_MAX_EXTRA_CHARS = 2;
const PROMPT_SAFETY_LATIN_REPLACEMENT_MAX_EXTRA_WORDS = 1;

const PROMPT_SAFETY_META_PREFIX_PATTERN = new RegExp(
  "^\\s*(?:\\u5408\\u89c4\\u4f18\\u5316\\u8bf4\\u660e|\\u5408\\u89c4\\u8bf4\\u660e|\\u66ff\\u6362\\u8bb0\\u5f55|\\u98ce\\u9669\\u5206\\u6790|\\u4fee\\u6539\\u8bf4\\u660e|\\u5ba1\\u8ba1\\u8bf4\\u660e)[:：]\\s*",
  "u",
);
const PROMPT_SAFETY_META_LINE_PATTERN = new RegExp(
  "^\\s*(?:(?:\\u5408\\u89c4\\u4f18\\u5316\\u8bf4\\u660e|\\u5408\\u89c4\\u8bf4\\u660e|\\u66ff\\u6362\\u8bb0\\u5f55|\\u98ce\\u9669\\u5206\\u6790|\\u4fee\\u6539\\u8bf4\\u660e|\\u5ba1\\u8ba1\\u8bf4\\u660e)[:：].*|(?:\\u6211\\u5df2\\u5c06|\\u5df2\\u5c06).*(?:\\u66ff\\u6362|\\u6539\\u5199|\\u4f18\\u5316).*)$",
  "u",
);

export class PromptSafetyCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptSafetyCodexQueueError";
  }
}

export async function createPromptSafetyCodexJob(
  input: CreatePromptSafetyCodexJobInput,
  options: QueueOptions = {},
) {
  validateCreateInput(input);

  const rootDir = resolveRootDir(options);
  const now = new Date().toISOString();
  const jobId = createId("prompt-safety-job");
  const outputFileName = `${jobId}.json`;
  const outputPath = path.join(resultDir(rootDir), outputFileName);
  const targetModel = input.targetModel || "SEEDANCE_2_0";
  const sourceResult = normalizePromptSafetySourceResult(input.sourceResult);
  const promptInput = {
    ...input,
    sourceResult,
  };
  const job: PromptSafetyCodexJob = {
    id: jobId,
    projectId: input.projectId || null,
    versionId: input.versionId || null,
    targetModel,
    promptText: input.promptText,
    sourceResult,
    prompt: buildPromptSafetyCodexPrompt(promptInput, outputPath, targetModel),
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

export async function getPromptSafetyCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  return syncAndSaveJob(rootDir, job);
}

export async function claimNextPromptSafetyCodexJob(options: ClaimOptions = {}) {
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
  const job: PromptSafetyCodexJob = {
    ...next,
    status: "running",
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  await writeJob(rootDir, job);
  return job;
}

export async function completePromptSafetyCodexJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const result = await readOutputJson(job.outputPath, job.sourceResult);
  const now = new Date().toISOString();
  const updated: PromptSafetyCodexJob = {
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

export async function failPromptSafetyCodexJob(
  jobId: string,
  message: string | undefined,
  options: QueueOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = applyJobStatus({
    ...job,
    status: "failed",
    error: message || "Codex prompt safety optimization failed",
    updatedAt: new Date().toISOString(),
  });
  await writeJob(rootDir, updated);
  return updated;
}

function buildPromptSafetyCodexPrompt(
  input: CreatePromptSafetyCodexJobInput,
  outputPath: string,
  targetModel: string,
) {
  return [
    "You are handling a Local Director prompt safety compliance rewrite task for Seedance 2.0.",
    "",
    "This is a compliance rewrite, not a moderation bypass.",
    "This is a strict word-level replacement pass, not a fresh creative generation.",
    "Do not evade moderation with homophones, spacing, symbol substitution, code words, or obfuscation.",
    "Preserve the story intent, shot count, timing, character continuity, camera language, and production structure.",
    "Use sourceResult as the immutable structure contract.",
    "Do not rewrite sentences, paragraphs, shots, story events, causal chains, or prompt structure.",
    "Only replace exact non-compliant words or short phrases with the closest compliant word or short phrase.",
    "Do not add wrapper text such as replacement logs, compliance reports, full prompt explanations, or extra storyboard tables inside optimizedResult.",
    "Keep findings and changeSummary only in the top-level JSON fields, never inside optimizedResult text fields.",
    "If the prompt cannot be made compliant without changing the core request, return status BLOCKED_NEEDS_USER_EDIT.",
    "",
    "Return strict JSON only by writing an object to the exact output path.",
    "Write the JSON file as UTF-8. Prefer Node.js fs.writeFileSync with JSON.stringify. Do not use PowerShell Set-Content or shell here-strings for Chinese text.",
    "Required JSON shape:",
    "{",
    '  "targetModel": "SEEDANCE_2_0",',
    '  "status": "PASSED | OPTIMIZED | BLOCKED_NEEDS_USER_EDIT",',
    '  "riskLevel": "NONE | LOW | MEDIUM | HIGH",',
    '  "findings": [{"field":"...","shotNumber":1,"original":"...","reason":"...","replacement":"...","severity":"low|medium|high"}],',
    '  "changeSummary": ["..."],',
    '  "patches": [{"path":"storyboard[0].videoPrompt","original":"exact risky substring","replacement":"clean replacement substring","riskType":"...","strategy":"...","severity":"low|medium|high"}]',
    "}",
    "",
    "Patch requirements:",
    "- Return patches only. Do not return a rewritten full optimizedResult.",
    "- Each patch path must point to an existing string field inside sourceResult, such as optimizedScript, workflow.fullVideoPrompt, storyboard[0].visual, storyboard[0].videoPrompt, storyboard[0].firstFramePrompt, storyboard[0].lastFramePrompt, storyboard[0].negativePrompt, or storyboard[0].dialogue.",
    "- original must be an exact substring from that field. replacement must be only the closest compliant word or short phrase.",
    "- Keep the sentence around original byte-for-byte identical; only original may change to replacement.",
    "- Do not expand a risky word into a new event, explanation, aftermath description, or sentence.",
    "- Chinese replacements must stay near the original length and may not exceed original by more than 2 characters.",
    "- Non-Chinese replacements should keep the same grammatical role and may not add more than 1 word.",
    "- Do not add, remove, reorder, merge, or split storyboard shots.",
    "- Keep shotNumber, timeRange, shot order, field names, and workflow structure unchanged.",
    "- Keep the final prompt pure for Seedance: no compliance explanation, no replacement report, no audit notes in replacement text.",
    "- Keep Chinese output when the source content is Chinese.",
    "",
    "Built-in lexical replacement examples:",
    "- 城管 -> 管理员",
    "- 赶她走 -> 劝她走",
    "- 被城管打伤 -> 被管理员伤到",
    "- 执法现场 -> 管理现场",
    "- 打伤 -> 伤到",
    "- Prefer the longest exact risky phrase first. Do not also patch a shorter word inside the same already-patched phrase.",
    "- Do not add replacement explanations to optimizedResult. Only the clean replaced prompt should remain.",
    "",
    `Target model: ${targetModel}`,
    `Output path: ${outputPath}`,
    "",
    "Source rendered prompt:",
    input.promptText,
    "",
    "Source AnalysisResult JSON:",
    JSON.stringify(input.sourceResult, null, 2),
    "",
    "Completion requirements:",
    "1. Create the output directory if it does not exist.",
    "2. Write only valid JSON to the output path.",
    "3. Validate that optimizedResult is complete and directly usable by Local Director.",
    "4. Reply with one line only: DONE.",
  ].join("\n");
}

async function syncAndSaveJob(rootDir: string, job: PromptSafetyCodexJob) {
  const synced = await syncJobFromOutputFile(job);
  const finalized = applyJobStatus(synced);
  if (JSON.stringify(finalized) !== JSON.stringify(job)) {
    await writeJob(rootDir, finalized);
  }
  return finalized;
}

async function syncJobFromOutputFile(job: PromptSafetyCodexJob) {
  if (job.status === "completed") return job;
  if (!(await isValidOutputJson(job.outputPath, job.sourceResult))) return job;

  return {
    ...job,
    status: "completed" as const,
    result: await readOutputJson(job.outputPath, job.sourceResult),
    error: null,
    completedAt: job.completedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function recoverStaleRunningJob(job: PromptSafetyCodexJob, runningTimeoutMs: number | undefined) {
  if (!runningTimeoutMs || runningTimeoutMs <= 0 || job.status !== "running") return job;

  const startedAtMs = Date.parse(job.startedAt || job.updatedAt || job.createdAt);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < runningTimeoutMs) return job;

  return {
    ...job,
    status: "pending" as const,
    startedAt: undefined,
    error: "Previous Codex run exceeded the prompt safety task timeout and was returned to the queue",
    updatedAt: new Date().toISOString(),
  };
}

function applyJobStatus(job: PromptSafetyCodexJob): PromptSafetyCodexJob {
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

async function readJob(rootDir: string, jobId: string): Promise<PromptSafetyCodexJob> {
  try {
    return JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as PromptSafetyCodexJob;
  } catch (error) {
    throw new PromptSafetyCodexQueueError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "Prompt safety Codex job not found" : "Prompt safety Codex job could not be read",
    );
  }
}

async function writeJob(rootDir: string, job: PromptSafetyCodexJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
  await mkdir(resultDir(rootDir), { recursive: true });
}

async function readOutputJson(filePath: string, sourceResult?: Record<string, unknown>) {
  try {
    const result = normalizePromptSafetyOptimizationResult(
      JSON.parse(stripJsonBom(await readFile(filePath, "utf8"))) as PromptSafetyCodexOutput,
      sourceResult,
    );
    validatePromptSafetyResultShape(result, sourceResult);
    return result;
  } catch (error) {
    throw new PromptSafetyCodexQueueError(
      error instanceof PromptSafetyCodexQueueError
        ? error.message
        : `Codex did not produce valid prompt safety JSON: ${filePath}`,
    );
  }
}

function stripJsonBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function isValidOutputJson(filePath: string, sourceResult?: Record<string, unknown>) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0) return false;
    await readOutputJson(filePath, sourceResult);
    return true;
  } catch {
    return false;
  }
}

function validatePromptSafetyResultShape(result: PromptSafetyOptimizationResult, sourceResult?: Record<string, unknown>) {
  if (!result || typeof result !== "object") {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON must be an object");
  }
  if (typeof result.targetModel !== "string" || !result.targetModel.trim()) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing targetModel");
  }
  if (!["PASSED", "OPTIMIZED", "BLOCKED_NEEDS_USER_EDIT"].includes(result.status)) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON has invalid status");
  }
  if (!["NONE", "LOW", "MEDIUM", "HIGH"].includes(result.riskLevel)) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON has invalid riskLevel");
  }
  if (!Array.isArray(result.findings)) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing findings");
  }
  if (!Array.isArray(result.changeSummary)) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing changeSummary");
  }
  if (!result.optimizedResult || typeof result.optimizedResult !== "object") {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing optimizedResult");
  }
  validateAnalysisResultShape(result.optimizedResult as Record<string, unknown>, "optimizedResult");
  if (sourceResult) {
    validateLocalRewriteStructure(result.optimizedResult as Record<string, unknown>, sourceResult);
  }
}

function validateLocalRewriteStructure(result: Record<string, unknown>, sourceResult: Record<string, unknown>) {
  const sourceStoryboard = Array.isArray(sourceResult.storyboard) ? sourceResult.storyboard : null;
  const optimizedStoryboard = Array.isArray(result.storyboard) ? result.storyboard : null;
  if (!sourceStoryboard || !optimizedStoryboard) return;

  if (optimizedStoryboard.length !== sourceStoryboard.length) {
    throw new PromptSafetyCodexQueueError("Prompt safety optimizedResult storyboard structure must match sourceResult");
  }

  sourceStoryboard.forEach((sourceShot, index) => {
    if (!sourceShot || typeof sourceShot !== "object") return;
    const sourceRecord = sourceShot as Record<string, unknown>;
    const optimizedRecord = optimizedStoryboard[index] as Record<string, unknown>;
    if (optimizedRecord.shotNumber !== sourceRecord.shotNumber) {
      throw new PromptSafetyCodexQueueError("Prompt safety optimizedResult storyboard structure must match sourceResult");
    }
    if (typeof sourceRecord.timeRange === "string" && optimizedRecord.timeRange !== sourceRecord.timeRange) {
      throw new PromptSafetyCodexQueueError("Prompt safety optimizedResult storyboard structure must match sourceResult");
    }
  });
}

function normalizePromptSafetySourceResult(sourceResult: Record<string, unknown>) {
  const normalizedSourceResult = cloneJsonObject(sourceResult);
  const sourceStoryboard = Array.isArray(normalizedSourceResult.storyboard) ? normalizedSourceResult.storyboard : null;
  if (!sourceStoryboard) return normalizedSourceResult;

  const duration = typeof normalizedSourceResult.duration === "string" ? normalizedSourceResult.duration : "";
  const storyboard = sourceStoryboard.map((shot, index) => {
    if (!shot || typeof shot !== "object") return shot;
    const record = shot as Record<string, unknown>;
    const existingTimeRange = typeof record.timeRange === "string" ? record.timeRange.trim() : "";
    return {
      ...record,
      timeRange: existingTimeRange || buildPromptSafetyShotTimeRange(index, sourceStoryboard.length, duration),
    };
  });

  return {
    ...normalizedSourceResult,
    storyboard,
  };
}

function normalizePromptSafetyOptimizationResult(
  result: PromptSafetyCodexOutput,
  sourceResult?: Record<string, unknown>,
): PromptSafetyOptimizationResult {
  if (!result || typeof result !== "object") return result as PromptSafetyOptimizationResult;
  if (!Array.isArray(result.patches)) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing patches");
  }
  const patches = result.patches;
  const optimizedResult = sourceResult
    ? buildPromptSafetyOptimizedResultFromPatches(sourceResult, patches)
    : result.optimizedResult && typeof result.optimizedResult === "object"
      ? result.optimizedResult
      : buildPromptSafetyOptimizedResultFromPatches(sourceResult, patches);
  return {
    ...result,
    patches,
    optimizedResult: applyPromptSafetyLexicalReplacements(optimizedResult) as Record<string, unknown>,
  };
}

function buildPromptSafetyOptimizedResultFromPatches(
  sourceResult: Record<string, unknown> | undefined,
  patches: PromptSafetyPatch[],
) {
  if (!sourceResult) {
    throw new PromptSafetyCodexQueueError("Prompt safety JSON is missing optimizedResult");
  }
  const optimizedResult = cloneJsonObject(sourceResult);
  groupPromptSafetyPatchesForApplication(patches).forEach((group) =>
    applyPromptSafetyPatchGroup(optimizedResult, group),
  );
  return optimizedResult;
}

function groupPromptSafetyPatchesForApplication(patches: PromptSafetyPatch[]) {
  const groups = new Map<string, Array<{ patch: PromptSafetyPatch; index: number }>>();
  patches.forEach((patch, index) => {
    const pathKey = typeof patch?.path === "string" ? patch.path : `__invalid_${index}`;
    const group = groups.get(pathKey) || [];
    group.push({ patch, index });
    groups.set(pathKey, group);
  });

  return [...groups.values()].map((group) =>
    group.sort((left, right) => {
      const leftLength = typeof left.patch?.original === "string" ? left.patch.original.length : 0;
      const rightLength = typeof right.patch?.original === "string" ? right.patch.original.length : 0;
      return rightLength - leftLength || left.index - right.index;
    }),
  );
}

function applyPromptSafetyPatchGroup(
  result: Record<string, unknown>,
  group: Array<{ patch: PromptSafetyPatch; index: number }>,
) {
  if (group.length < 1) return;

  const first = group[0];
  validatePromptSafetyPatch(first.patch, first.index);
  const segments = parsePromptSafetyPatchPath(first.patch.path);
  const originalValue = getPromptSafetyPathValue(result, segments);
  if (typeof originalValue !== "string") {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${first.index} path must point to a string field`);
  }

  let nextValue = originalValue;
  group.forEach(({ patch, index }) => {
    validatePromptSafetyPatch(patch, index);
    if (patch.path !== first.patch.path) {
      throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} path could not be grouped`);
    }
    if (!originalValue.includes(patch.original)) {
      throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} original text does not match sourceResult`);
    }
    const replacement = normalizePromptSafetyPatchReplacement(patch.replacement);
    validatePromptSafetyPatchReplacement(patch.original, replacement, index);
    nextValue = nextValue.split(patch.original).join(replacement);
  });

  setPromptSafetyPathValue(result, segments, nextValue);
}

function validatePromptSafetyPatch(patch: PromptSafetyPatch, index: number) {
  if (!patch || typeof patch !== "object") {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} must be an object`);
  }
  if (typeof patch.path !== "string" || !patch.path.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} is missing path`);
  }
  if (typeof patch.original !== "string" || !patch.original.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} is missing original`);
  }
  if (typeof patch.replacement !== "string" || !patch.replacement.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} is missing replacement`);
  }
}

function normalizePromptSafetyPatchReplacement(value: string) {
  return stripPromptSafetyMetaText(applyPromptSafetyLexicalReplacementText(value));
}

function validatePromptSafetyPatchReplacement(original: string, replacement: string, index: number) {
  if (!replacement.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} replacement is empty after cleanup`);
  }
  if (replacement.includes("\n") || replacement.includes("\r")) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} replacement must be a single word or short phrase`);
  }

  if (containsCjk(original) || containsCjk(replacement)) {
    if (replacement.length > original.length + PROMPT_SAFETY_CJK_REPLACEMENT_MAX_EXTRA_CHARS) {
      throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} replacement must stay near the original length`);
    }
    return;
  }

  const originalWords = countPromptSafetyWords(original);
  const replacementWords = countPromptSafetyWords(replacement);
  if (replacementWords > originalWords + PROMPT_SAFETY_LATIN_REPLACEMENT_MAX_EXTRA_WORDS) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} replacement must not add new wording`);
  }

  const maxExtraChars = Math.max(8, Math.ceil(original.length * 0.25));
  if (replacement.length > original.length + maxExtraChars) {
    throw new PromptSafetyCodexQueueError(`Prompt safety patch ${index} replacement must stay near the original length`);
  }
}

function parsePromptSafetyPatchPath(value: string) {
  const normalized = value.trim().replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 1) {
    throw new PromptSafetyCodexQueueError("Prompt safety patch path is empty");
  }
  return segments;
}

function getPromptSafetyPathValue(root: unknown, segments: string[]) {
  return segments.reduce((current, segment) => {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (current && typeof current === "object") {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, root);
}

function setPromptSafetyPathValue(root: Record<string, unknown>, segments: string[], value: string) {
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    current = Array.isArray(current)
      ? current[Number.parseInt(segment, 10)]
      : current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  const finalSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    current[Number.parseInt(finalSegment, 10)] = value;
    return;
  }
  if (current && typeof current === "object") {
    (current as Record<string, unknown>)[finalSegment] = value;
    return;
  }
  throw new PromptSafetyCodexQueueError("Prompt safety patch path could not be applied");
}

function cloneJsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function applyPromptSafetyLexicalReplacements(value: unknown): unknown {
  if (typeof value === "string") {
    return applyPromptSafetyLexicalReplacementText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyPromptSafetyLexicalReplacements(item));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = applyPromptSafetyLexicalReplacements(item);
    }
    return next;
  }
  return value;
}

function applyPromptSafetyLexicalReplacementText(value: string) {
  const replaced = PROMPT_SAFETY_LEXICAL_REPLACEMENTS.reduce(
    (text, [from, to]) => text.split(from).join(to),
    value,
  );
  return stripPromptSafetyMetaText(replaced);
}

function containsCjk(value: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function countPromptSafetyWords(value: string) {
  const matches = value.trim().match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g);
  return matches ? matches.length : Math.max(1, value.trim().length);
}

function stripPromptSafetyMetaText(value: string) {
  const withoutPrefix = value.replace(PROMPT_SAFETY_META_PREFIX_PATTERN, "");
  return withoutPrefix
    .split(/\r?\n/)
    .filter((line) => !PROMPT_SAFETY_META_LINE_PATTERN.test(line))
    .join("\n")
    .trim();
}

function buildPromptSafetyShotTimeRange(index: number, totalShots: number, duration: string) {
  const safeTotal = Math.max(1, totalShots);
  const totalSeconds = parsePromptSafetyDurationSeconds(duration);
  const start = (totalSeconds * index) / safeTotal;
  const end = (totalSeconds * (index + 1)) / safeTotal;
  return `${formatPromptSafetySecond(start)}-${formatPromptSafetySecond(end)}秒`;
}

function parsePromptSafetyDurationSeconds(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)/);
  const seconds = match ? Number.parseFloat(match[1]) : 15;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 15;
}

function formatPromptSafetySecond(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function validateAnalysisResultShape(result: Record<string, unknown>, prefix: string) {
  const workflow = result.workflow && typeof result.workflow === "object"
    ? (result.workflow as Record<string, unknown>)
    : {};
  if (typeof result.optimizedScript !== "string" || !result.optimizedScript.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety JSON is missing ${prefix}.optimizedScript`);
  }
  if (typeof workflow.fullVideoPrompt !== "string" || !workflow.fullVideoPrompt.trim()) {
    throw new PromptSafetyCodexQueueError(`Prompt safety JSON is missing ${prefix}.workflow.fullVideoPrompt`);
  }
  if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
    throw new PromptSafetyCodexQueueError(`Prompt safety JSON is missing ${prefix}.storyboard`);
  }
  result.storyboard.forEach((shot, index) => {
    if (!shot || typeof shot !== "object") {
      throw new PromptSafetyCodexQueueError(`Prompt safety JSON ${prefix}.storyboard[${index}] must be an object`);
    }
    const record = shot as Record<string, unknown>;
    for (const field of REQUIRED_STORYBOARD_SHOT_FIELDS) {
      if (field === "shotNumber") {
        if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
          throw new PromptSafetyCodexQueueError(`Prompt safety JSON is missing ${prefix}.storyboard[${index}].${field}`);
        }
        continue;
      }
      if (typeof record[field] !== "string" || !record[field].trim()) {
        throw new PromptSafetyCodexQueueError(`Prompt safety JSON is missing ${prefix}.storyboard[${index}].${field}`);
      }
    }
  });
}

function validateCreateInput(input: CreatePromptSafetyCodexJobInput) {
  const promptText = String(input.promptText || "").trim();
  if (promptText.length < 5) {
    throw new PromptSafetyCodexQueueError("Prompt text must contain at least 5 characters");
  }
  if (promptText.length > 120_000) {
    throw new PromptSafetyCodexQueueError("Prompt text is too long for one prompt safety job");
  }
  if (!input.sourceResult || typeof input.sourceResult !== "object") {
    throw new PromptSafetyCodexQueueError("sourceResult is required");
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
