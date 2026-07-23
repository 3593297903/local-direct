import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  claimNextFileJob,
  fileJobResultDir,
  finishRunningFileJob,
  getFileJob,
  putPendingFileJob,
  readRunningFileJob,
  type FileJobRecord,
} from "./file-job-store";
import { buildBatchSegmentResultHash } from "./batch-segment-repair-patch";
import { assertCleanCodexPromptInput, compileCodexPromptText } from "./codex-prompt-input-compiler";
import { applyPromptSafetyPolicyDeep, type PromptSafetyDiff } from "./prompt-safety-policy";
import type { CharacterContinuityLock, SegmentEvidenceSelector } from "./batch-segment-contract";

export type EventCoverageJudgeStatus = "covered" | "missing" | "contradiction" | "uncertain";

export type EventCoverageJudgeCase = {
  segmentIndex: number;
  slotId: string;
  label: string;
  importance: "blocking";
  contractHash: string;
  resultHash: string;
  anchorGroups: string[][];
  conceptGroups: string[][];
  contradictionGroups: string[][];
  sourceExcerpt: string;
  characterLocks: CharacterContinuityLock[];
  forbiddenFutureEvents: string[];
  evidenceSelectors: SegmentEvidenceSelector[];
  inspectedFields: Array<{ path: string; text: string }>;
};

export type EventCoverageJudgeDecision = {
  segmentIndex: number;
  slotId: string;
  status: EventCoverageJudgeStatus;
  evidence: Array<{ path: string; quote: string }>;
  inspectedPaths: string[];
};

export type EventCoverageJudgeResult = {
  schemaVersion: 1;
  waveId: string;
  decisions: EventCoverageJudgeDecision[];
};

export type EventCoverageCodexJob = FileJobRecord & {
  batchId: string;
  waveId: string;
  idempotencyKey: string;
  cases: EventCoverageJudgeCase[];
  modelCases: EventCoverageJudgeCase[];
  safetyDiffs: PromptSafetyDiff[];
  prompt: string;
  outputPath: string;
  result: EventCoverageJudgeResult | null;
  error: string | null;
  completedAt?: string;
};

export type CreateEventCoverageCodexJobInput = {
  batchId: string;
  waveId: string;
  cases: EventCoverageJudgeCase[];
};

type StoreOptions = { rootDir?: string };
type ClaimOptions = StoreOptions & { order?: "oldest" | "newest"; runningTimeoutMs?: number };

const NAMESPACE = ".tmp-event-coverage-codex";

export class EventCoverageCodexQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCoverageCodexQueueError";
  }
}

export async function createEventCoverageCodexJob(
  input: CreateEventCoverageCodexJobInput,
  options: StoreOptions = {},
) {
  const normalized = validateCreateInput(input);
  const rootDir = resolveRootDir(options);
  const idempotencyKey = buildBatchSegmentResultHash({
    batchId: normalized.batchId,
    waveId: normalized.waveId,
    cases: normalized.cases.map((item) => [item.segmentIndex, item.slotId, item.contractHash, item.resultHash]),
  });
  const id = `event-coverage-judge-${idempotencyKey}`;
  const outputPath = path.join(fileJobResultDir(rootDir, NAMESPACE), `${id}.json`);
  const now = new Date().toISOString();
  const modelPrepass = applyPromptSafetyPolicyDeep(normalized.cases, { phase: "quality" });
  const modelInput = { ...normalized, cases: modelPrepass.sourceTextForModel };
  const prompt = buildJudgePrompt(modelInput, outputPath);
  assertCleanCodexPromptInput(prompt, "Event coverage judge prompt");
  const job: EventCoverageCodexJob = {
    id,
    status: "pending",
    leaseId: null,
    batchId: normalized.batchId,
    waveId: normalized.waveId,
    idempotencyKey,
    cases: normalized.cases,
    modelCases: modelInput.cases,
    safetyDiffs: modelPrepass.safetyDiffs,
    prompt,
    outputPath,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return putPendingFileJob(rootDir, NAMESPACE, job);
}

export async function getEventCoverageCodexJob(jobId: string, options: StoreOptions = {}) {
  return getFileJob<EventCoverageCodexJob>(resolveRootDir(options), NAMESPACE, jobId);
}

export async function claimNextEventCoverageCodexJob(options: ClaimOptions = {}) {
  return claimNextFileJob<EventCoverageCodexJob>(resolveRootDir(options), NAMESPACE, options);
}

export async function completeEventCoverageCodexJob(
  jobId: string,
  leaseId: string,
  options: StoreOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const { job } = await readRunningFileJob<EventCoverageCodexJob>(rootDir, NAMESPACE, jobId, leaseId);
  const result = await readAndValidateJudgeResult(job);
  return finishRunningFileJob(rootDir, NAMESPACE, {
    ...job,
    result,
    error: null,
    completedAt: new Date().toISOString(),
  }, "completed");
}

export async function failEventCoverageCodexJob(
  jobId: string,
  leaseId: string,
  message: string | undefined,
  options: StoreOptions = {},
) {
  const rootDir = resolveRootDir(options);
  const { job } = await readRunningFileJob<EventCoverageCodexJob>(rootDir, NAMESPACE, jobId, leaseId);
  return finishRunningFileJob(rootDir, NAMESPACE, {
    ...job,
    result: null,
    error: message || "Event coverage decisions-only task failed",
  }, "failed");
}

function validateCreateInput(input: CreateEventCoverageCodexJobInput) {
  const batchId = requiredText(input.batchId, "batchId", 200);
  const waveId = requiredText(input.waveId, "waveId", 200);
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 30) {
    throw new EventCoverageCodexQueueError("Judge wave must contain 1-30 cases");
  }
  const seen = new Set<string>();
  const cases = input.cases.map((item) => {
    const segmentIndex = Number(item.segmentIndex);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 1 || segmentIndex > 30) throw new EventCoverageCodexQueueError("Judge case segmentIndex is invalid");
    const slotId = requiredText(item.slotId, "slotId", 200);
    const caseKey = `${segmentIndex}:${slotId}`;
    if (seen.has(caseKey)) throw new EventCoverageCodexQueueError("Judge wave contains a duplicate case");
    seen.add(caseKey);
    const inspectedFields = (item.inspectedFields || []).map((field) => ({
      path: normalizeEvidencePath(field.path),
      text: requiredText(field.text, "inspected field text", 4_000),
    }));
    if (!inspectedFields.length || inspectedFields.length > 20 || inspectedFields.some((field) => !isAllowedEvidencePath(field.path))) {
      throw new EventCoverageCodexQueueError("Judge case has invalid inspected fields");
    }
    return {
      segmentIndex,
      slotId,
      label: requiredText(item.label, "label", 500),
      importance: "blocking" as const,
      contractHash: requiredText(item.contractHash, "contractHash", 200),
      resultHash: requiredText(item.resultHash, "resultHash", 200),
      anchorGroups: normalizeGroups(item.anchorGroups),
      conceptGroups: normalizeGroups(item.conceptGroups),
      contradictionGroups: normalizeGroups(item.contradictionGroups),
      sourceExcerpt: requiredText(item.sourceExcerpt, "sourceExcerpt", 4_000),
      characterLocks: normalizeCharacterLocks(item.characterLocks),
      forbiddenFutureEvents: normalizeTextArray(item.forbiddenFutureEvents, 20, 500),
      evidenceSelectors: normalizeEvidenceSelectors(item.evidenceSelectors),
      inspectedFields,
    };
  });
  return { batchId, waveId, cases };
}

function buildJudgePrompt(input: ReturnType<typeof validateCreateInput>, outputPath: string) {
  return [
    "You are handling a Local Director decisions-only event coverage task.",
    "Judge only whether each listed event is covered, missing, contradicted, or uncertain in the supplied short user-facing fields.",
    "Do not generate or rewrite video prompts. Do not return repairs, replacements, storyboard, workflow, analysis, confidence, or commentary.",
    "Write one strict JSON object with exactly schemaVersion, waveId, and decisions.",
    "Each decision must contain segmentIndex, slotId, status, evidence, and inspectedPaths.",
    "status must be covered, missing, contradiction, or uncertain.",
    "covered and contradiction require an exact short quote from an inspected field. missing requires every inspected path to be listed. When unsure, return uncertain.",
    "Write UTF-8 JSON to the exact output path and reply with exactly DONE.",
    "",
    compileCodexPromptText(JSON.stringify(input, null, 2), { phase: "quality" }),
    `Output path: ${outputPath}`,
  ].join("\n");
}

async function readAndValidateJudgeResult(job: EventCoverageCodexJob) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(await readFile(job.outputPath, "utf8")));
  } catch {
    throw new EventCoverageCodexQueueError("Judge did not produce valid decisions-only JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new EventCoverageCodexQueueError("Judge output must be decisions-only JSON");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "waveId", "decisions"].includes(key)) || !Array.isArray(record.decisions)) {
    throw new EventCoverageCodexQueueError("Judge output must be decisions-only JSON");
  }
  if (record.schemaVersion !== 1 || record.waveId !== job.waveId) throw new EventCoverageCodexQueueError("Judge schema or waveId mismatch");
  if (record.decisions.length !== job.cases.length) throw new EventCoverageCodexQueueError("Judge did not return one decision per case");
  const modelCases = Array.isArray(job.modelCases) && job.modelCases.length === job.cases.length
    ? job.modelCases
    : job.cases;
  const caseMap = new Map(job.cases.map((item, index) => [
    `${item.segmentIndex}:${item.slotId}`,
    { original: item, model: modelCases[index] || item },
  ]));
  const seen = new Set<string>();
  const decisions = record.decisions.map((item) => validateDecision(item, caseMap, seen));
  return { schemaVersion: 1 as const, waveId: job.waveId, decisions };
}

function validateDecision(
  value: unknown,
  caseMap: Map<string, { original: EventCoverageJudgeCase; model: EventCoverageJudgeCase }>,
  seen: Set<string>,
): EventCoverageJudgeDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventCoverageCodexQueueError("Judge decision is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["segmentIndex", "slotId", "status", "evidence", "inspectedPaths"].includes(key))) {
    throw new EventCoverageCodexQueueError("Judge decision contains unknown fields");
  }
  const segmentIndex = Number(record.segmentIndex);
  const slotId = String(record.slotId || "");
  const key = `${segmentIndex}:${slotId}`;
  const sourceCases = caseMap.get(key);
  if (!sourceCases || seen.has(key)) throw new EventCoverageCodexQueueError("Judge decision references an unknown or duplicate case");
  seen.add(key);
  const status = String(record.status || "") as EventCoverageJudgeStatus;
  if (!["covered", "missing", "contradiction", "uncertain"].includes(status)) throw new EventCoverageCodexQueueError("Judge decision has invalid status");
  const inspectedPaths = Array.isArray(record.inspectedPaths)
    ? record.inspectedPaths.map((item) => normalizeEvidencePath(String(item || "")))
    : [];
  const expectedPaths = sourceCases.original.inspectedFields.map((item) => item.path).sort();
  if (JSON.stringify([...new Set(inspectedPaths)].sort()) !== JSON.stringify([...new Set(expectedPaths)].sort())) {
    throw new EventCoverageCodexQueueError("Judge decision did not inspect the complete path set");
  }
  let evidence: Array<{ path: string; quote: string }> = [];
  try {
    evidence = Array.isArray(record.evidence)
      ? record.evidence.map((item) => validateEvidence(item, sourceCases.original, sourceCases.model))
      : [];
  } catch {
    return { segmentIndex, slotId, status: "uncertain", evidence: [], inspectedPaths: expectedPaths };
  }
  if ((status === "covered" || status === "contradiction") && !evidence.length) {
    throw new EventCoverageCodexQueueError("Judge covered/contradiction decision is missing evidence quote");
  }
  return { segmentIndex, slotId, status, evidence, inspectedPaths: expectedPaths };
}

function validateEvidence(
  value: unknown,
  sourceCase: EventCoverageJudgeCase,
  modelCase: EventCoverageJudgeCase,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventCoverageCodexQueueError("Judge evidence is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["path", "quote"].includes(key))) throw new EventCoverageCodexQueueError("Judge evidence contains unknown fields");
  const evidencePath = normalizeEvidencePath(String(record.path || ""));
  const quote = requiredText(record.quote, "evidence quote", 160);
  const source = sourceCase.inspectedFields.find((item) => item.path === evidencePath);
  const modelSource = modelCase.inspectedFields.find((item) => item.path === evidencePath) || source;
  if (!source || !modelSource || !normalizeQuote(modelSource.text).includes(normalizeQuote(quote))) {
    throw new EventCoverageCodexQueueError("Judge evidence quote was not found in the inspected field");
  }
  const originalQuote = mapModelQuoteToOriginal(modelSource.text, source.text, quote);
  if (!originalQuote) throw new EventCoverageCodexQueueError("Judge evidence quote could not be mapped to the original field");
  return { path: evidencePath, quote: originalQuote };
}

function normalizeGroups(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((group) => Array.isArray(group) ? group.map((item) => String(item || "").trim()).filter(Boolean) : []).filter((group) => group.length);
}

function normalizeTextArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, maxItems).map((item) => item.slice(0, maxLength));
}

function normalizeCharacterLocks(value: unknown): CharacterContinuityLock[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const lock = item as CharacterContinuityLock;
    if (!lock.characterId || !lock.displayName || !lock.factKey || !lock.expectedValue) return [];
    return [{
      characterId: String(lock.characterId).slice(0, 200),
      displayName: String(lock.displayName).slice(0, 200),
      factKey: String(lock.factKey).slice(0, 200),
      expectedValue: String(lock.expectedValue).slice(0, 500),
      mode: "must_not_contradict" as const,
      contradictionSignals: normalizeGroups(lock.contradictionSignals),
      appliesFromSegment: Number.isInteger(lock.appliesFromSegment) ? lock.appliesFromSegment : undefined,
      appliesThroughSegment: Number.isInteger(lock.appliesThroughSegment) ? lock.appliesThroughSegment : undefined,
    }];
  });
}

function normalizeEvidenceSelectors(value: unknown): SegmentEvidenceSelector[] {
  if (!Array.isArray(value)) return [];
  const selectors: SegmentEvidenceSelector[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const selector = item as SegmentEvidenceSelector;
    if (selector.source === "optimizedScript") {
      selectors.push({ source: "optimizedScript", fields: [], requireExecutableShot: false });
      continue;
    }
    if (selector.source !== "storyboard") continue;
    selectors.push({
      source: "storyboard",
      shotNumber: selector.shotNumber === "any" || Number.isInteger(selector.shotNumber) ? selector.shotNumber : "any",
      fields: (selector.fields || []).filter((field) => [
        "visual", "dialogue", "shotPurpose", "videoPrompt", "firstFramePrompt", "lastFramePrompt",
      ].includes(field)),
      requireExecutableShot: selector.requireExecutableShot !== false,
    });
  }
  return selectors;
}

function mapModelQuoteToOriginal(modelText: string, originalText: string, quote: string) {
  const directIndex = originalText.indexOf(quote);
  if (directIndex >= 0) return originalText.slice(directIndex, directIndex + quote.length);
  const modelIndex = modelText.indexOf(quote);
  if (modelIndex < 0) return "";

  for (let width = 16; width >= 4; width -= 2) {
    const left = modelText.slice(Math.max(0, modelIndex - width), modelIndex);
    const right = modelText.slice(modelIndex + quote.length, modelIndex + quote.length + width);
    const leftIndex = left ? originalText.indexOf(left) : 0;
    const rightIndex = right ? originalText.indexOf(right, Math.max(0, leftIndex + left.length)) : originalText.length;
    if (leftIndex < 0 || rightIndex < 0) continue;
    const start = leftIndex + left.length;
    const candidate = originalText.slice(start, rightIndex).trim();
    if (candidate && candidate.length <= 160) return candidate;
  }
  return "";
}

function isAllowedEvidencePath(value: string) {
  return value === "optimizedScript"
    || /^storyboard\[\d+]\.(visual|dialogue|shotPurpose|videoPrompt|firstFramePrompt|lastFramePrompt)$/.test(value);
}

function normalizeEvidencePath(value: string) {
  return String(value || "").replace(/^result\./, "").trim();
}

function normalizeQuote(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[，。；：、“”"'！？!?]/g, "");
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new EventCoverageCodexQueueError(`${label} is missing or too long`);
  return text;
}

function stripBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function resolveRootDir(options: StoreOptions) {
  return path.resolve(options.rootDir || process.cwd());
}
