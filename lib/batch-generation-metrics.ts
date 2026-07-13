import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import ts from "typescript";
import type { AnalysisResult } from "../types";
import type {
  BatchInvocationCounters,
  BatchInvocationEvent,
} from "./batch-generation-invocation-ledger";
import {
  createEmptyBatchInvocationCounters,
  installBatchInvocationObserver,
  recordBatchInvocation,
  summarizeBatchInvocations,
} from "./batch-generation-invocation-ledger";
import type {
  BatchSegmentQualityFinding,
  BatchSegmentQualityGate,
  DeterministicQualityPatchResult,
} from "./batch-segment-quality-gate";
import type { SegmentContract } from "./batch-segment-contract";

export const FROZEN_DASHBOARD_ADAPTER_VERSION = "frozen-dashboard-local-v1";

const DASHBOARD_PIPELINE_FUNCTIONS = [
  "buildVideoGenerationPromptText",
  "normalizeBatchSegmentResultForQuality",
  "canonicalizeBatchSegmentResult",
  "normalizePatchAndEvaluateBatchSegment",
] as const;

export type NumericSampleSummary = {
  p50: number;
  p90: number;
  p95: number;
  max: number;
  mean: number;
  standardDeviation: number;
  coefficientOfVariation: number;
};

export type BatchBenchmarkReportV1 = {
  schemaVersion: 1;
  gitCommit: string;
  branch: string;
  nodeVersion: string;
  platform: string;
  fixtureId: string;
  fixtureHash: string;
  iterations: number;
  warmups: number;
  order: "alternating-baseline-task";
  timingsMs: Record<string, NumericSampleSummary>;
  payloadBytes: Record<string, { p50: number; p95: number; max: number }>;
  invocationCounters: BatchInvocationCounters;
  quality: {
    accepted: number;
    blocked: number;
    needsReview: number;
    scoreP50: number;
    scoreP95: number;
    promptLengths: { min: number; p50: number; p95: number; max: number };
    shotCounts: Record<string, number>;
    missingRequiredFields: number;
    changedUnmatchedPaths: number;
  };
  extensions: BatchBenchmarkExtensionsV1;
  generatedAt: string;
};

export type BatchBenchmarkExtensionsV1 = {
  adapterVersion: string;
  productionSourceFingerprint: string;
  canonicalPromptHashes: string[];
  modelPromptLengths: { min: number; p50: number; p95: number; max: number };
  localPatchOperations: number;
  localPatchSegments: number;
  uniquePatchPaths: string[];
  routeDecisionCounts: Record<string, number>;
  findingCounts: Record<"blocking" | "patchable" | "warning" | "risk", number>;
};

export type BatchGenerationFixtureLike = {
  schemaVersion: 1;
  fixtureId: string;
  sourceHash: string;
  requestedDuration: string;
  segmentCount: number;
  contracts: SegmentContract[];
  renderedResults: AnalysisResult[];
  qualityContext: Array<{
    episodeIndex: number;
    expectedShotCount: number;
    minFullPromptLength: number;
  }>;
  expected?: {
    adapterVersion?: string;
    productionSourceFingerprint?: string;
  };
};

export type BatchPipelineAdapter = {
  adapterVersion: string;
  productionSourceFingerprint: string;
  normalizeBatchSegmentResultForQuality: (result: AnalysisResult) => AnalysisResult;
  canonicalizeBatchSegmentResult: (result: AnalysisResult) => AnalysisResult;
  buildVideoGenerationPromptText: (result: AnalysisResult) => string;
  evaluateBatchSegmentQuality: (
    result: AnalysisResult,
    options: Record<string, unknown>,
  ) => BatchSegmentQualityGate;
  selectDeterministicQualityPatchFindings: (
    findings: readonly BatchSegmentQualityFinding[],
    options: { safetyEnabled: boolean },
  ) => BatchSegmentQualityFinding[];
  applyDeterministicQualityPatchWithDiff: (
    result: AnalysisResult,
    findings: BatchSegmentQualityFinding[],
  ) => DeterministicQualityPatchResult<AnalysisResult>;
  createSegmentQualityReport: (input: Record<string, unknown>) => {
    qualityScore: number;
    status: string;
  };
  routeBatchSegmentOutcome: (input: Record<string, unknown>) => {
    action: string;
  };
};

export type BenchmarkModelAdapters = {
  seasonPack(input: BenchmarkModelAdapterInput): void;
  renderPack(input: BenchmarkModelAdapterInput): void;
  singleGeneration(input: BenchmarkModelAdapterInput): void;
  pathRepair(input: BenchmarkModelAdapterInput): void;
  coverageJudge(input: BenchmarkModelAdapterInput): void;
  safetyRewrite(input: BenchmarkModelAdapterInput): void;
  contractCorrection(input: BenchmarkModelAdapterInput): void;
};

export type BenchmarkModelAdapterInput = {
  batchId: string;
  segmentIndexes: number[];
  reasonCode: string;
};

export class UnexpectedBenchmarkModelInvocation extends Error {
  constructor(readonly kind: keyof BenchmarkModelAdapters, readonly input: BenchmarkModelAdapterInput) {
    super(`Unexpected benchmark model invocation: ${kind}`);
    this.name = "UnexpectedBenchmarkModelInvocation";
  }
}

type TimedReplayResult = {
  timingsMs: Record<string, number>;
  payloadBytes: Record<string, number>;
  invocationCounters: BatchInvocationCounters;
  quality: {
    accepted: number;
    acceptedSegmentIndexes: number[];
    blocked: number;
    needsReview: number;
    needsReviewSegmentIndexes: number[];
    scores: number[];
    promptLengths: number[];
    shotCounts: Record<string, number>;
    missingRequiredFields: number;
    changedUnmatchedPaths: number;
    localPatchOperations: number;
    localPatchSegments: number;
    uniquePatchPaths: string[];
    canonicalPromptHashes: string[];
    modelPromptLengths: number[];
    routeDecisionCounts: Record<string, number>;
    findingCounts: Record<"blocking" | "patchable" | "warning" | "risk", number>;
    blockingFindingFingerprints: string[];
  };
};

type CreateBatchBenchmarkReportInput = Omit<
  BatchBenchmarkReportV1,
  "schemaVersion" | "order" | "quality"
> & {
  quality: {
    accepted: number;
    blocked: number;
    needsReview: number;
    scores: number[];
    promptLengths: number[];
    shotCounts: Record<string, number>;
    missingRequiredFields: number;
    changedUnmatchedPaths: number;
  };
  extensions: BatchBenchmarkExtensionsV1;
};

export function extractDashboardProductionSourceFingerprint(root: string) {
  const dashboardPath = path.join(path.resolve(root), "components", "DashboardClient.tsx");
  const source = readFileSync(dashboardPath, "utf8").replace(/\r\n/g, "\n");
  const sourceFile = ts.createSourceFile(
    dashboardPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functionSources = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    if (!(DASHBOARD_PIPELINE_FUNCTIONS as readonly string[]).includes(name)) continue;
    functionSources.set(name, source.slice(statement.getStart(sourceFile), statement.end).trim());
  }
  const missing = DASHBOARD_PIPELINE_FUNCTIONS.filter((name) => !functionSources.has(name));
  if (missing.length) {
    throw new Error(`Cannot fingerprint Dashboard pipeline functions: ${missing.join(", ")}`);
  }
  const canonicalSource = DASHBOARD_PIPELINE_FUNCTIONS
    .map((name) => `${name}\n${functionSources.get(name)}`)
    .join("\n\n");
  return {
    dashboardPath,
    functionNames: [...DASHBOARD_PIPELINE_FUNCTIONS],
    functionHashes: Object.fromEntries(DASHBOARD_PIPELINE_FUNCTIONS.map((name) => [
      name,
      hashText(functionSources.get(name) || ""),
    ])),
    fingerprint: hashText(canonicalSource),
  };
}

export function createFrozenDashboardLocalAdapter(root: string): BatchPipelineAdapter {
  const resolvedRoot = path.resolve(root);
  const rootRequire = createRequire(path.join(resolvedRoot, "package.json"));
  const gate = rootRequire(path.join(resolvedRoot, "lib", "batch-segment-quality-gate.ts"));
  const qualityReport = rootRequire(path.join(resolvedRoot, "lib", "batch-segment-quality-report.ts"));
  const router = rootRequire(path.join(resolvedRoot, "lib", "batch-segment-outcome-router.ts"));
  const tokenSanitizer = rootRequire(path.join(resolvedRoot, "lib", "internal-prompt-token-sanitizer.ts"));
  const sourceFingerprint = extractDashboardProductionSourceFingerprint(resolvedRoot);

  const cleanPromptValue = (value: unknown, fallback = "") => {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "undefined" || trimmed === "null" || /\bundefined\b/.test(trimmed)) return fallback;
    return trimmed;
  };
  const cleanPromptContentType = (value: unknown, fallback = "短剧 / 通用") => {
    const raw = typeof value === "string" ? value.trim() : "";
    const sanitized = cleanPromptValue(raw ? tokenSanitizer.sanitizeInternalPromptTokens(raw) : "", "");
    if (!sanitized || tokenSanitizer.findInternalPromptToken(raw)) return fallback;
    if (/^(?:单段视频提示词结果|视频提示词结果|视频段)$/.test(sanitized)) return fallback;
    return sanitized;
  };
  const sanitizeBatchSegmentText = (value: string) => tokenSanitizer.sanitizeInternalPromptTokens(
    value
      .replace(/第\s*([0-9一二三四五六七八九十百]+)\s*集/g, "第$1段")
      .replace(/本集/g, "本段")
      .replace(/单集/g, "单段")
      .replace(/剧集/g, "分段")
      .replace(/16\s*:\s*9\s*竖屏/g, "16:9横屏")
      .replace(/竖屏\s*16\s*:\s*9/g, "16:9横屏")
      .replace(/横屏\s*竖屏/g, "横屏"),
  );
  const sanitizeBatchNegativePrompt = (value: unknown) => {
    const raw = typeof value === "string" ? value.trim() : "";
    const cleaned = sanitizeBatchSegmentText(raw)
      .replace(/\bundefined\b/gi, "空字段")
      .replace(/\bnull\b/gi, "空值");
    const baseItems = ["空字段占位表达", "跨段引用占位表达", "不可执行省略描述", "16:9画幅方向冲突"];
    const parts = cleaned.split(/[,，、]/).map((part: string) => part.trim()).filter(Boolean);
    for (const item of baseItems) {
      if (!parts.some((part: string) => part.includes(item))) parts.push(item);
    }
    return parts.join("，");
  };
  const sanitizeBatchSegmentOutput = <T>(value: T): T => tokenSanitizer.sanitizeInternalPromptTokensDeep(
    (function sanitizeSegmentLabels(item: unknown): unknown {
      if (typeof item === "string") return sanitizeBatchSegmentText(item);
      if (Array.isArray(item)) return item.map((entry) => sanitizeSegmentLabels(entry));
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, sanitizeSegmentLabels(entry)]),
      );
    })(value),
  ) as T;
  const normalizeBatchSegmentResultForQuality = (result: AnalysisResult): AnalysisResult => {
    const sanitized = sanitizeBatchSegmentOutput(result);
    const storyboard = Array.isArray(sanitized.storyboard)
      ? sanitized.storyboard.map((shot) => ({
        ...shot,
        dialogue: cleanPromptValue(shot.dialogue, "") || "无",
        negativePrompt: sanitizeBatchNegativePrompt(shot.negativePrompt),
      }))
      : [];
    const workflow = sanitized.workflow
      ? {
        ...sanitized.workflow,
        fullNegativePrompt: sanitizeBatchNegativePrompt(sanitized.workflow.fullNegativePrompt),
      }
      : sanitized.workflow;
    return { ...sanitized, workflow, storyboard };
  };
  const buildVideoGenerationPromptText = (result: AnalysisResult) => {
    const workflow = result.workflow;
    const title = cleanPromptValue(result.title, "未命名视频提示词");
    const duration = cleanPromptValue(result.duration, "15秒");
    const style = cleanPromptValue(result.style, "电影级写实");
    const contentType = cleanPromptContentType(result.contentType);
    const coreTheme = cleanPromptValue(workflow?.coreTheme, "") || `${title}：围绕原文案核心事件，保持人物关系、线索顺序和情绪推进，生成一段可直接执行的 AI 视频提示词。`;
    const technicalParams = cleanPromptValue(workflow?.videoParameterLock, "") || [
      `总时长：${duration}`,
      "画幅：16:9",
      `风格：${style}`,
      `场景：${contentType}对应的主要空间，保持原文案地点、时间、天气和人物关系一致。`,
      "运镜原则：按线索推进顺序设计镜头，由空间建立到关键动作，再到人物反应和段尾转场。",
      "光影原则：根据题材控制主色调、明暗层次和真实光源，不使用突兀过曝或廉价特效。",
      "声音原则：以真实环境声、动作声和必要台词为主，不使用喧宾夺主的背景音乐。",
      "画面表达重点：用空间、动作、物件、人物反应和镜头节奏表达剧情，不依赖血腥、怪物、突脸惊吓或无关元素。",
    ].join("\n");
    const shotLines = (Array.isArray(result.storyboard) ? result.storyboard : []).map((shot) =>
      `${shot.timeRange || "-"}｜镜头${shot.shotNumber}｜${shot.shotType || "镜头"}｜${shot.scene || shot.shotPurpose || "剧情推进"}\n\n${shot.visual || shot.videoPrompt}\n${shot.composition ? `机位/构图：${shot.composition}` : ""}\n${shot.cameraMovement ? `运镜：${shot.cameraMovement}` : ""}\n${shot.lighting ? `光影：${shot.lighting}` : ""}\n声音：${shot.sound || "真实环境声。"}\n台词：${shot.dialogue || "无台词。"}\n这一镜作用：${shot.shotPurpose || "推动剧情信息，让观众顺着画面线索进入下一镜。"}`,
    ).join("\n\n");
    return tokenSanitizer.sanitizeInternalPromptTokens([
      `核心主题\n\n${coreTheme}`,
      `技术参数\n\n${technicalParams}`,
      `镜头画面 + 时间轴 + 声音 / 台词\n${shotLines}`,
    ].filter(Boolean).join("\n\n"));
  };
  const canonicalizeBatchSegmentResult = (result: AnalysisResult): AnalysisResult => {
    const normalized = normalizeBatchSegmentResultForQuality(result);
    const canonicalFullVideoPrompt = buildVideoGenerationPromptText(normalized);
    const workflow = normalized.workflow
      ? { ...normalized.workflow, fullVideoPrompt: canonicalFullVideoPrompt, filmScript: canonicalFullVideoPrompt }
      : normalized.workflow;
    return { ...normalized, workflow };
  };

  return {
    adapterVersion: FROZEN_DASHBOARD_ADAPTER_VERSION,
    productionSourceFingerprint: sourceFingerprint.fingerprint,
    normalizeBatchSegmentResultForQuality,
    canonicalizeBatchSegmentResult,
    buildVideoGenerationPromptText,
    evaluateBatchSegmentQuality: gate.evaluateBatchSegmentQuality,
    selectDeterministicQualityPatchFindings: gate.selectDeterministicQualityPatchFindings,
    applyDeterministicQualityPatchWithDiff: gate.applyDeterministicQualityPatchWithDiff,
    createSegmentQualityReport: qualityReport.createSegmentQualityReport,
    routeBatchSegmentOutcome: router.routeBatchSegmentOutcome,
  };
}

export function createThrowingBenchmarkModelAdapters(
  defaults: Pick<BenchmarkModelAdapterInput, "batchId">,
): BenchmarkModelAdapters {
  const invoke = (kind: keyof BenchmarkModelAdapters, input: BenchmarkModelAdapterInput) => {
    const invocationKind = benchmarkAdapterKind(kind);
    const baseEvent = {
      batchId: input.batchId || defaults.batchId,
      segmentIndexes: input.segmentIndexes,
      kind: invocationKind,
      jobId: `benchmark:${invocationKind}:${input.segmentIndexes.join("-")}`,
      reasonCode: input.reasonCode,
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    for (const phase of ["planned", "created", "executing"] as const) {
      recordBatchInvocation({
        ...baseEvent,
        eventId: `${baseEvent.jobId}:${phase}`,
        phase,
      });
    }
    throw new UnexpectedBenchmarkModelInvocation(kind, input);
  };
  return {
    seasonPack: (input) => invoke("seasonPack", input),
    renderPack: (input) => invoke("renderPack", input),
    singleGeneration: (input) => invoke("singleGeneration", input),
    pathRepair: (input) => invoke("pathRepair", input),
    coverageJudge: (input) => invoke("coverageJudge", input),
    safetyRewrite: (input) => invoke("safetyRewrite", input),
    contractCorrection: (input) => invoke("contractCorrection", input),
  };
}

export function dispatchReplayRoute(
  route: { action: string },
  adapters: BenchmarkModelAdapters,
  input: BenchmarkModelAdapterInput,
) {
  if (route.action === "accept" || route.action === "needs_review") return;
  if (route.action === "regenerate_segment") return adapters.singleGeneration(input);
  if (route.action === "request_quality_patch" || route.action === "request_event_patch") {
    return adapters.pathRepair(input);
  }
  if (route.action === "enqueue_judge" || route.action === "enqueue_judge_shadow") {
    return adapters.coverageJudge(input);
  }
  throw new Error(`Unsupported replay route: ${route.action}`);
}

function benchmarkAdapterKind(kind: keyof BenchmarkModelAdapters): BatchInvocationEvent["kind"] {
  const kinds: Record<keyof BenchmarkModelAdapters, BatchInvocationEvent["kind"]> = {
    seasonPack: "season_pack",
    renderPack: "render_pack",
    singleGeneration: "single_generation",
    pathRepair: "path_repair",
    coverageJudge: "coverage_judge",
    safetyRewrite: "safety_rewrite",
    contractCorrection: "contract_correction",
  };
  return kinds[kind];
}

export function summarizeNumericSamples(values: readonly number[]): NumericSampleSummary {
  if (!values.length) {
    return { p50: 0, p90: 0, p95: 0, max: 0, mean: 0, standardDeviation: 0, coefficientOfVariation: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) || 0,
    mean,
    standardDeviation,
    coefficientOfVariation: mean > 0 ? standardDeviation / mean : 0,
  };
}

export function summarizePayloadSamples(values: readonly number[]) {
  const summary = summarizeNumericSamples(values);
  return { p50: summary.p50, p95: summary.p95, max: summary.max };
}

export function createBatchBenchmarkReport(input: CreateBatchBenchmarkReportInput): BatchBenchmarkReportV1 {
  const promptLengths = [...input.quality.promptLengths].sort((left, right) => left - right);
  const scores = [...input.quality.scores].sort((left, right) => left - right);
  return {
    schemaVersion: 1,
    gitCommit: input.gitCommit,
    branch: input.branch,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    fixtureId: input.fixtureId,
    fixtureHash: input.fixtureHash,
    iterations: input.iterations,
    warmups: input.warmups,
    order: "alternating-baseline-task",
    timingsMs: input.timingsMs,
    payloadBytes: input.payloadBytes,
    invocationCounters: input.invocationCounters,
    quality: {
      accepted: input.quality.accepted,
      blocked: input.quality.blocked,
      needsReview: input.quality.needsReview,
      scoreP50: percentile(scores, 0.5),
      scoreP95: percentile(scores, 0.95),
      promptLengths: {
        min: promptLengths[0] || 0,
        p50: percentile(promptLengths, 0.5),
        p95: percentile(promptLengths, 0.95),
        max: promptLengths.at(-1) || 0,
      },
      shotCounts: input.quality.shotCounts,
      missingRequiredFields: input.quality.missingRequiredFields,
      changedUnmatchedPaths: input.quality.changedUnmatchedPaths,
    },
    extensions: structuredClone(input.extensions),
    generatedAt: input.generatedAt,
  };
}

export function assertBatchBenchmarkInvariants(report: BatchBenchmarkReportV1) {
  if (report.schemaVersion !== 1) throw new Error("Unsupported benchmark report schema");
  if (!/^[a-f0-9]{64}$/i.test(report.fixtureHash)) throw new Error("Fixture integrity hash is invalid");
  for (const [kind, counters] of Object.entries(report.invocationCounters)) {
    if (counters.executing !== 0) {
      throw new Error(`Clean fixture created a model-backed invocation: ${kind}`);
    }
  }
  if (report.quality.promptLengths.min < 900) throw new Error("Prompt quality fell below the 900-character hard minimum");
  if (report.quality.missingRequiredFields > 0) throw new Error("Fixture replay has missing required fields");
  if (report.quality.changedUnmatchedPaths > 0) throw new Error("Deterministic patch changed unmatched paths");
  if (report.quality.blocked > 0) throw new Error("Frozen clean fixture contains blocking quality findings");
  if (report.extensions.adapterVersion !== FROZEN_DASHBOARD_ADAPTER_VERSION) {
    throw new Error("Frozen adapter version is not accepted");
  }
  if (!/^[a-f0-9]{64}$/i.test(report.extensions.productionSourceFingerprint)) {
    throw new Error("Production source fingerprint is invalid");
  }
  if (report.extensions.canonicalPromptHashes.length !== report.quality.accepted) {
    throw new Error("Canonical prompt hash count does not match accepted segments");
  }
  if (report.extensions.canonicalPromptHashes.some((value) => !/^[a-f0-9]{64}$/i.test(value))) {
    throw new Error("Canonical prompt hash is invalid");
  }
}

export function runTimedBatchFixtureReplay(
  fixture: BatchGenerationFixtureLike,
  adapter: BatchPipelineAdapter,
  options: { modelAdapters?: BenchmarkModelAdapters } = {},
): TimedReplayResult {
  if (fixture.expected?.adapterVersion && fixture.expected.adapterVersion !== adapter.adapterVersion) {
    throw new Error("Fixture adapter version does not match the frozen production adapter");
  }
  if (
    fixture.expected?.productionSourceFingerprint
    && fixture.expected.productionSourceFingerprint !== adapter.productionSourceFingerprint
  ) {
    throw new Error("Fixture production source fingerprint does not match DashboardClient.tsx");
  }
  const mutableResults = fixture.renderedResults.map((result) => structuredClone(result));
  const modelAdapters = options.modelAdapters || createThrowingBenchmarkModelAdapters({
    batchId: `fixture:${fixture.fixtureId}`,
  });
  const invocationEvents: BatchInvocationEvent[] = [];
  const uninstall = installBatchInvocationObserver((event) => invocationEvents.push(event));
  const timers = {
    quality_gate_total: 0,
    deterministic_patch_total: 0,
    canonical_prompt_total: 0,
    cache_encode_total: 0,
    status_dto_encode_total: 0,
    full_local_pipeline_total: 0,
  };
  const replayQuality = {
    accepted: 0,
    acceptedSegmentIndexes: [] as number[],
    blocked: 0,
    needsReview: 0,
    needsReviewSegmentIndexes: [] as number[],
    scores: [] as number[],
    promptLengths: [] as number[],
    shotCounts: {} as Record<string, number>,
    missingRequiredFields: 0,
    changedUnmatchedPaths: 0,
    localPatchOperations: 0,
    localPatchSegments: 0,
    uniquePatchPaths: [] as string[],
    canonicalPromptHashes: [] as string[],
    modelPromptLengths: [] as number[],
    routeDecisionCounts: {} as Record<string, number>,
    findingCounts: { blocking: 0, patchable: 0, warning: 0, risk: 0 },
    blockingFindingFingerprints: [] as string[],
  };
  const patchPaths = new Set<string>();
  const cachedSegments: Array<Record<string, unknown>> = [];
  const pipelineStartedAt = performance.now();

  try {
    mutableResults.forEach((rawResult, offset) => {
      const contract = fixture.contracts[offset];
      const context = fixture.qualityContext[offset];
      const normalizedResult = adapter.normalizeBatchSegmentResultForQuality(rawResult);

      const firstGateStartedAt = performance.now();
      const firstGate = adapter.evaluateBatchSegmentQuality(normalizedResult, {
        ...context,
        segmentIndex: context.episodeIndex,
        contract,
        fullPromptText: adapter.buildVideoGenerationPromptText(normalizedResult),
        coverageMode: "shadow",
      });
      timers.quality_gate_total += performance.now() - firstGateStartedAt;

      const patchStartedAt = performance.now();
      const selected = adapter.selectDeterministicQualityPatchFindings(firstGate.findings, { safetyEnabled: true });
      const patched = adapter.applyDeterministicQualityPatchWithDiff(normalizedResult, selected);
      timers.deterministic_patch_total += performance.now() - patchStartedAt;

      const canonicalStartedAt = performance.now();
      const canonicalResult = adapter.canonicalizeBatchSegmentResult(patched.result);
      const canonicalPrompt = canonicalResult.workflow?.fullVideoPrompt || "";
      timers.canonical_prompt_total += performance.now() - canonicalStartedAt;

      let finalGate = firstGate;
      if (patched.patchDiffs.length) {
        const finalGateStartedAt = performance.now();
        finalGate = adapter.evaluateBatchSegmentQuality(canonicalResult, {
          ...context,
          segmentIndex: context.episodeIndex,
          contract,
          fullPromptText: adapter.buildVideoGenerationPromptText(canonicalResult),
          coverageMode: "shadow",
        });
        timers.quality_gate_total += performance.now() - finalGateStartedAt;
      }

      const route = adapter.routeBatchSegmentOutcome({
        gate: finalGate,
        hasUsableResult: Array.isArray(canonicalResult.storyboard) && canonicalResult.storyboard.length > 0,
        coverageStage: "shadow",
      });
      const report = adapter.createSegmentQualityReport({
        batchId: `fixture:${fixture.fixtureId}`,
        segmentIndex: context.episodeIndex,
        title: canonicalResult.title,
        result: canonicalResult,
        sourceText: contract.sourceText,
        status: route.action === "accept" ? "cached" : "needs_review",
        scheduleProfile: "PHASE_0_BENCHMARK",
        qualityGate: finalGate,
        patchDiffs: patched.patchDiffs,
        contractHash: contract.contractHash,
      });
      replayQuality.routeDecisionCounts[route.action] = (replayQuality.routeDecisionCounts[route.action] || 0) + 1;
      dispatchReplayRoute(route, modelAdapters, {
        batchId: `fixture:${fixture.fixtureId}`,
        segmentIndexes: [context.episodeIndex],
        reasonCode: finalGate.blockingFindings[0]?.code || route.action,
      });

      if (route.action === "accept") {
        replayQuality.accepted += 1;
        replayQuality.acceptedSegmentIndexes.push(context.episodeIndex);
      } else {
        replayQuality.needsReview += 1;
        replayQuality.needsReviewSegmentIndexes.push(context.episodeIndex);
      }
      replayQuality.blocked += finalGate.blockingFindings.length ? 1 : 0;
      replayQuality.scores.push(report.qualityScore);
      replayQuality.promptLengths.push(compactLength(canonicalPrompt));
      replayQuality.modelPromptLengths.push(compactLength(rawResult.workflow?.fullVideoPrompt));
      replayQuality.canonicalPromptHashes.push(hashText(canonicalPrompt));
      const shotCount = String(canonicalResult.storyboard?.length || 0);
      replayQuality.shotCounts[shotCount] = (replayQuality.shotCounts[shotCount] || 0) + 1;
      replayQuality.missingRequiredFields += finalGate.findings.filter((finding) => finding.code === "missing_required_field").length;
      replayQuality.localPatchOperations += patched.patchDiffs.length;
      if (patched.patchDiffs.length) replayQuality.localPatchSegments += 1;
      patched.patchDiffs.forEach((diff) => patchPaths.add(diff.path));
      for (const finding of finalGate.findings) replayQuality.findingCounts[finding.severity] += 1;
      finalGate.blockingFindings.forEach((finding) => replayQuality.blockingFindingFingerprints.push(
        finding.fingerprint || `${context.episodeIndex}:${finding.code}:${finding.path || "segment"}`,
      ));
      const allowedPatchPaths = [
        ...patched.patchDiffs.map((diff) => diff.path),
        "workflow.fullVideoPrompt",
        "workflow.filmScript",
      ];
      if (
        stableProjectionWithoutPaths(normalizedResult, allowedPatchPaths)
        !== stableProjectionWithoutPaths(canonicalResult, allowedPatchPaths)
      ) replayQuality.changedUnmatchedPaths += 1;
      cachedSegments.push({
        episodeIndex: context.episodeIndex,
        result: canonicalResult,
        promptText: canonicalPrompt,
        sourceText: contract.sourceText,
      });
    });

    const cacheDocument = {
      schemaVersion: 2,
      revision: 1,
      batchId: `fixture:${fixture.fixtureId}`,
      durableBatchId: `fixture:${fixture.fixtureId}`,
      projectId: "synthetic-project",
      sourceHash: fixture.sourceHash,
      contractHash: hashStable(fixture.contracts.map((contract) => contract.contractHash)),
      resolvedSegmentCount: fixture.segmentCount,
      updatedAt: "2026-07-13T00:00:00.000Z",
      segmentStates: fixture.qualityContext.map(({ episodeIndex }) => ({ index: episodeIndex, status: "cached" })),
      activeJobIds: [],
      qualityReports: [],
      segments: cachedSegments,
      needsReviewSegments: [],
    };
    const cacheStartedAt = performance.now();
    const cacheJson = JSON.stringify(cacheDocument);
    timers.cache_encode_total += performance.now() - cacheStartedAt;
    const statusDto = {
      batchId: cacheDocument.batchId,
      status: replayQuality.needsReview ? "needs_review" : "cached",
      segmentCount: fixture.segmentCount,
      accepted: replayQuality.accepted,
      needsReview: replayQuality.needsReview,
      activeJobIds: [],
    };
    const statusStartedAt = performance.now();
    const statusJson = JSON.stringify(statusDto);
    timers.status_dto_encode_total += performance.now() - statusStartedAt;
    const fullJobJson = JSON.stringify({
      status: "completed",
      contracts: fixture.contracts,
      results: cachedSegments,
    });
    replayQuality.uniquePatchPaths = [...patchPaths].sort();
    replayQuality.blockingFindingFingerprints.sort();
    timers.full_local_pipeline_total = performance.now() - pipelineStartedAt;
    return {
      timingsMs: timers,
      payloadBytes: {
        batchCache: Buffer.byteLength(cacheJson, "utf8"),
        statusDto: Buffer.byteLength(statusJson, "utf8"),
        fullJobPayload: Buffer.byteLength(fullJobJson, "utf8"),
      },
      invocationCounters: summarizeBatchInvocations(invocationEvents),
      quality: replayQuality,
    };
  } finally {
    uninstall();
  }
}

export function aggregateTimedReplays(runs: readonly TimedReplayResult[]) {
  const timerKeys = new Set(runs.flatMap((run) => Object.keys(run.timingsMs)));
  const payloadKeys = new Set(runs.flatMap((run) => Object.keys(run.payloadBytes)));
  return {
    timingsMs: Object.fromEntries([...timerKeys].map((key) => [
      key,
      summarizeNumericSamples(runs.map((run) => run.timingsMs[key]).filter(Number.isFinite)),
    ])),
    payloadBytes: Object.fromEntries([...payloadKeys].map((key) => [
      key,
      summarizePayloadSamples(runs.map((run) => run.payloadBytes[key]).filter(Number.isFinite)),
    ])),
  };
}

export function buildBenchmarkCanonicalPrompt(result: AnalysisResult) {
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];
  return [
    String(result.title || "").trim(),
    String(result.duration || "").trim(),
    String(result.style || "").trim(),
    String(result.workflow?.fullVideoPrompt || "").trim(),
    ...storyboard.map((shot) => [
      shot.timeRange,
      shot.scene,
      shot.visual,
      shot.composition,
      shot.cameraMovement,
      shot.lighting,
      shot.sound,
      shot.dialogue,
      shot.emotion,
      shot.transition,
      shot.shotPurpose,
      shot.firstFramePrompt,
      shot.videoPrompt,
      shot.lastFramePrompt,
      shot.negativePrompt,
    ].filter(Boolean).join("\n")),
  ].filter(Boolean).join("\n");
}

function stableProjectionWithoutPaths(result: AnalysisResult, pathsToRemove: readonly string[]) {
  const projection = structuredClone(result) as unknown as Record<string, unknown>;
  for (const itemPath of pathsToRemove) deleteObjectPath(projection, itemPath);
  return JSON.stringify(sortStableValue(projection));
}

function deleteObjectPath(root: Record<string, unknown>, itemPath: string) {
  const tokens = [...itemPath.matchAll(/([^.[\]]+)|\[(\d+)\]/g)]
    .map((match) => match[1] ?? Number(match[2]));
  if (!tokens.length) return;
  let parent: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (!parent || typeof parent !== "object") return;
    parent = (parent as Record<string | number, unknown>)[token];
  }
  if (!parent || typeof parent !== "object") return;
  delete (parent as Record<string | number, unknown>)[tokens.at(-1) as string | number];
}

function sortStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortStableValue(entry)]),
  );
}

function percentile(sortedValues: readonly number[], quantile: number) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function compactLength(value: unknown) {
  return String(value || "").replace(/\s+/g, "").length;
}

function hashStable(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hashText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export { createEmptyBatchInvocationCounters };
