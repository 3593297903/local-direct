import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AnalysisResult } from "../types";
import type {
  BatchInvocationCounters,
  BatchInvocationEvent,
} from "./batch-generation-invocation-ledger";
import {
  createEmptyBatchInvocationCounters,
  installBatchInvocationObserver,
  summarizeBatchInvocations,
} from "./batch-generation-invocation-ledger";
import type {
  BatchSegmentQualityFinding,
  BatchSegmentQualityGate,
  DeterministicQualityPatchResult,
} from "./batch-segment-quality-gate";
import type { SegmentContract } from "./batch-segment-contract";

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
  generatedAt: string;
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
};

export type BatchPipelineAdapter = {
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

type TimedReplayResult = {
  timingsMs: Record<string, number>;
  payloadBytes: Record<string, number>;
  invocationCounters: BatchInvocationCounters;
  quality: {
    accepted: number;
    blocked: number;
    needsReview: number;
    scores: number[];
    promptLengths: number[];
    shotCounts: Record<string, number>;
    missingRequiredFields: number;
    changedUnmatchedPaths: number;
    localPatchOperations: number;
    uniquePatchPaths: string[];
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
};

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
}

export function runTimedBatchFixtureReplay(
  fixture: BatchGenerationFixtureLike,
  adapter: BatchPipelineAdapter,
): TimedReplayResult {
  const mutableResults = fixture.renderedResults.map((result) => structuredClone(result));
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
    blocked: 0,
    needsReview: 0,
    scores: [] as number[],
    promptLengths: [] as number[],
    shotCounts: {} as Record<string, number>,
    missingRequiredFields: 0,
    changedUnmatchedPaths: 0,
    localPatchOperations: 0,
    uniquePatchPaths: [] as string[],
  };
  const patchPaths = new Set<string>();
  const cachedSegments: Array<Record<string, unknown>> = [];
  const pipelineStartedAt = performance.now();

  try {
    mutableResults.forEach((rawResult, offset) => {
      const contract = fixture.contracts[offset];
      const context = fixture.qualityContext[offset];
      const immutableBefore = immutableQualityProjection(rawResult);

      const firstGateStartedAt = performance.now();
      const firstGate = adapter.evaluateBatchSegmentQuality(rawResult, {
        ...context,
        segmentIndex: context.episodeIndex,
        contract,
        fullPromptText: rawResult.workflow?.fullVideoPrompt,
        coverageMode: "shadow",
      });
      timers.quality_gate_total += performance.now() - firstGateStartedAt;

      const patchStartedAt = performance.now();
      const selected = adapter.selectDeterministicQualityPatchFindings(firstGate.findings, { safetyEnabled: true });
      const patched = adapter.applyDeterministicQualityPatchWithDiff(rawResult, selected);
      timers.deterministic_patch_total += performance.now() - patchStartedAt;

      let finalGate = firstGate;
      if (patched.patchDiffs.length) {
        const finalGateStartedAt = performance.now();
        finalGate = adapter.evaluateBatchSegmentQuality(patched.result, {
          ...context,
          segmentIndex: context.episodeIndex,
          contract,
          fullPromptText: patched.result.workflow?.fullVideoPrompt,
          coverageMode: "shadow",
        });
        timers.quality_gate_total += performance.now() - finalGateStartedAt;
      }

      const canonicalStartedAt = performance.now();
      const canonicalPrompt = buildBenchmarkCanonicalPrompt(patched.result);
      timers.canonical_prompt_total += performance.now() - canonicalStartedAt;
      const route = adapter.routeBatchSegmentOutcome({
        gate: finalGate,
        hasUsableResult: Array.isArray(patched.result.storyboard) && patched.result.storyboard.length > 0,
        coverageStage: "shadow",
      });
      const report = adapter.createSegmentQualityReport({
        batchId: `fixture:${fixture.fixtureId}`,
        segmentIndex: context.episodeIndex,
        title: patched.result.title,
        result: patched.result,
        sourceText: contract.sourceText,
        status: route.action === "accept" ? "cached" : "needs_review",
        scheduleProfile: "PHASE_0_BENCHMARK",
        qualityGate: finalGate,
        patchDiffs: patched.patchDiffs,
        contractHash: contract.contractHash,
      });

      if (route.action === "accept") replayQuality.accepted += 1;
      else replayQuality.needsReview += 1;
      replayQuality.blocked += finalGate.blockingFindings.length ? 1 : 0;
      replayQuality.scores.push(report.qualityScore);
      replayQuality.promptLengths.push(compactLength(patched.result.workflow?.fullVideoPrompt));
      const shotCount = String(patched.result.storyboard?.length || 0);
      replayQuality.shotCounts[shotCount] = (replayQuality.shotCounts[shotCount] || 0) + 1;
      replayQuality.missingRequiredFields += finalGate.findings.filter((finding) => finding.code === "missing_required_field").length;
      replayQuality.localPatchOperations += patched.patchDiffs.length;
      patched.patchDiffs.forEach((diff) => patchPaths.add(diff.path));
      if (immutableQualityProjection(patched.result) !== immutableBefore) replayQuality.changedUnmatchedPaths += 1;
      cachedSegments.push({
        episodeIndex: context.episodeIndex,
        result: patched.result,
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

function immutableQualityProjection(result: AnalysisResult) {
  return JSON.stringify({
    diagnosis: result.diagnosis,
    optimizedScript: result.optimizedScript,
    recommendedItems: result.recommendedItems,
    editingNotes: result.editingNotes,
    sourceAnalysis: result.workflow?.sourceAnalysis,
    screenplay: result.workflow?.screenplay,
    filmScript: result.workflow?.filmScript,
    concisePrompt: result.workflow?.concisePrompt,
    shotPurposes: result.storyboard?.map((shot) => shot.shotPurpose),
  });
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

export { createEmptyBatchInvocationCounters };
