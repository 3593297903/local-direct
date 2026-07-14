import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import fixture20, {
  FIXTURE_SHA256 as FIXTURE_20_SHA256,
  canonicalizeFixture,
  cloneFixture,
  computeFixtureHash,
} from "./fixtures/batch-generation/batch-generation-20-segment.mjs";
import fixture30, {
  FIXTURE_SHA256 as FIXTURE_30_SHA256,
} from "./fixtures/batch-generation/batch-generation-30-segment.mjs";
import * as fixture20Module from "./fixtures/batch-generation/batch-generation-20-segment.mjs";
import * as fixture30Module from "./fixtures/batch-generation/batch-generation-30-segment.mjs";
import {
  OBSERVED_SHAPE_PROFILE_20,
  OBSERVED_SHAPE_PROFILE_30,
} from "./fixtures/batch-generation/shape-profiles.mjs";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  applyDeterministicQualityPatchWithDiff,
  evaluateBatchSegmentQuality,
  selectDeterministicQualityPatchFindings,
} = require("../lib/batch-segment-quality-gate.ts");
const { createSegmentQualityReport } = require("../lib/batch-segment-quality-report.ts");
const { routeBatchSegmentOutcome } = require("../lib/batch-segment-outcome-router.ts");
const { compileSegmentContractRenderBlock } = require("../lib/codex-prompt-input-compiler.ts");
const {
  installBatchInvocationObserver,
  summarizeBatchInvocations,
} = require("../lib/batch-generation-invocation-ledger.ts");
const {
  FROZEN_DASHBOARD_ADAPTER_VERSION,
  UnexpectedBenchmarkModelInvocation,
  createFrozenDashboardLocalAdapter,
  createThrowingBenchmarkModelAdapters,
  extractDashboardProductionSourceFingerprint,
  runTimedBatchFixtureReplay,
} = require("../lib/batch-generation-metrics.ts");

const MODEL_KINDS = [
  "season_pack",
  "render_pack",
  "single_generation",
  "path_repair",
  "coverage_judge",
  "safety_rewrite",
  "contract_correction",
];

const COMPLETE_DASHBOARD_PIPELINE_FUNCTIONS = [
  "buildVideoGenerationPromptText",
  "cleanPromptValue",
  "cleanPromptContentType",
  "sanitizeBatchSegmentText",
  "sanitizeBatchNegativePrompt",
  "sanitizeBatchSegmentOutput",
  "normalizeBatchSegmentResultForQuality",
  "canonicalizeBatchSegmentResult",
  "inferBatchEpisodeSourceInfo",
  "minimumBatchStoryboardShotCount",
  "maximumBatchStoryboardShotCount",
  "minimumBatchFullPromptLength",
  "normalizePatchAndEvaluateBatchSegment",
];

function replayFixture(inputFixture) {
  const fixture = cloneFixture(inputFixture);
  const replay = runTimedBatchFixtureReplay(fixture, createFrozenDashboardLocalAdapter(process.cwd()));
  return {
    acceptedSegmentIndexes: replay.quality.acceptedSegmentIndexes,
    needsReviewSegmentIndexes: replay.quality.needsReviewSegmentIndexes,
    blockingFindingFingerprints: replay.quality.blockingFindingFingerprints,
    uniquePatchPaths: replay.quality.uniquePatchPaths,
    invocationCounters: replay.invocationCounters,
    localPatchCount: replay.quality.localPatchOperations,
    fullRegenerationCount: replay.invocationCounters.single_generation.executing,
    pathRepairCount: replay.invocationCounters.path_repair.executing,
    missingRequiredFields: replay.quality.missingRequiredFields,
    qualityScores: replay.quality.scores,
    promptLengths: replay.quality.promptLengths,
    shotCounts: replay.quality.shotCounts,
    canonicalPromptHashes: replay.quality.canonicalPromptHashes,
  };
}

function collectFixtureContentText(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((item) => collectFixtureContentText(item, key));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return [];
    if (/(?:hash|fingerprint)$/i.test(key)) return [];
    return [value];
  }
  return Object.entries(value).flatMap(([childKey, childValue]) =>
    collectFixtureContentText(childValue, childKey));
}

function assertFixtureIntegrity(fixture, expectedHash) {
  assert.equal(computeFixtureHash(fixture), expectedHash);
  assert.equal(fixture.contracts.length, fixture.segmentCount);
  assert.equal(fixture.renderedResults.length, fixture.segmentCount);
  assert.equal(fixture.qualityContext.length, fixture.segmentCount);
  assert.equal(Buffer.from(canonicalizeFixture(fixture), "utf8").toString("utf8"), canonicalizeFixture(fixture));
  assert.doesNotMatch(canonicalizeFixture(fixture), /(?:undefined|null)/i);
  fixture.renderedResults.forEach((result, index) => {
    assert.equal(
      result.storyboard.length,
      fixture.qualityContext[index].expectedShotCount,
      `segment ${index + 1} should keep its declared shot count`,
    );
    assert.ok(
      result.workflow.fullVideoPrompt.replace(/\s+/g, "").length >= 900,
      `segment ${index + 1} should keep the 900-character production hard floor`,
    );
  });
  const nearLimit = compileSegmentContractRenderBlock(fixture.contracts.at(-1));
  assert.ok(nearLimit.byteLength >= 2_400 && nearLimit.byteLength <= 3_072);
}

function summarizeObservedValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (fraction) => sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )];
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: sorted.length ? quantile(0.5) : null,
    p95: sorted.length ? quantile(0.95) : null,
    max: sorted.at(-1) ?? null,
    total: sorted.reduce((total, value) => total + value, 0),
  };
}

function assertRelativeTolerance(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  const allowed = Math.max(1, Math.abs(expected) * tolerance);
  assert.ok(
    delta <= allowed,
    `${label}: expected ${actual} to remain within ${(tolerance * 100).toFixed(0)}% of ${expected}`,
  );
}

function shapeProfileHash(profile) {
  const numericProfile = structuredClone(profile);
  delete numericProfile.sourceShapeHash;
  return createHash("sha256").update(canonicalizeFixture(numericProfile), "utf8").digest("hex");
}

function observedShape(profile) {
  const isTwenty = profile.segmentCount === 20;
  return {
    promptLengthSummary: profile.promptLengthSummary || profile.observedPromptLengthSummary,
    resultByteSummary: profile.resultByteSummary || (isTwenty
      ? { min: 23_407, p50: 29_533, p95: 37_313, max: 43_293 }
      : { min: 29_160, p50: 38_246, p95: 49_770, max: 50_383 }),
    contractByteSummary: profile.contractByteSummary || (isTwenty
      ? { min: 1_755, p50: 1_854, p95: 1_967, max: 2_873 }
      : { min: 1_834, p50: 2_209, p95: 2_606, max: 2_606 }),
    shotFieldLengthSummaries: profile.shotFieldLengthSummaries,
    findingSummary: profile.findingSummary || (isTwenty
      ? {
          blocking: { p50: 0, p95: 0, max: 0, total: 0 },
          patchable: { p50: 0, p95: 0, max: 0, total: 0 },
          warning: { p50: 9, p95: 19, max: 19, total: 136 },
          risk: { p50: 1, p95: 14, max: 28, total: 92 },
        }
      : {
          blocking: { p50: 0, p95: 0, max: 0, total: 0 },
          patchable: { p50: 0, p95: 0, max: 0, total: 0 },
          warning: { p50: 5, p95: 12, max: 12, total: 171 },
          risk: { p50: 3, p95: 15, max: 23, total: 156 },
        }),
    localPatchSummary: profile.localPatchSummary || (isTwenty
      ? { p50: 0, p95: 8, max: 8, total: 57 }
      : { p50: 4, p95: 11, max: 11, total: 147 }),
  };
}

function collectFixtureWorkloadShape(fixture) {
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());
  const patchCounts = [];
  const warningCounts = [];
  const riskCounts = [];
  const blockingCounts = [];
  const patchableCounts = [];

  fixture.renderedResults.forEach((rawResult, offset) => {
    const result = cloneFixture(rawResult);
    const contract = fixture.contracts[offset];
    const context = fixture.qualityContext[offset];
    const normalized = adapter.normalizeBatchSegmentResultForQuality(result);
    const firstGate = adapter.evaluateBatchSegmentQuality(normalized, {
      ...context,
      segmentIndex: context.episodeIndex,
      contract,
      fullPromptText: adapter.buildVideoGenerationPromptText(normalized),
      coverageMode: "shadow",
    });
    const selected = adapter.selectDeterministicQualityPatchFindings(firstGate.findings, {
      safetyEnabled: true,
    });
    const patched = adapter.applyDeterministicQualityPatchWithDiff(normalized, selected);
    const canonical = adapter.canonicalizeBatchSegmentResult(patched.result);
    const finalGate = patched.patchDiffs.length
      ? adapter.evaluateBatchSegmentQuality(canonical, {
          ...context,
          segmentIndex: context.episodeIndex,
          contract,
          fullPromptText: adapter.buildVideoGenerationPromptText(canonical),
          coverageMode: "shadow",
        })
      : firstGate;
    patchCounts.push(patched.patchDiffs.length);
    warningCounts.push(finalGate.warningFindings.length);
    riskCounts.push(finalGate.riskFindings.length);
    blockingCounts.push(finalGate.blockingFindings.length);
    patchableCounts.push(finalGate.patchableFindings.length);
  });

  return {
    patch: summarizeObservedValues(patchCounts),
    warning: summarizeObservedValues(warningCounts),
    risk: summarizeObservedValues(riskCounts),
    blocking: summarizeObservedValues(blockingCounts),
    patchable: summarizeObservedValues(patchableCounts),
  };
}

test("fixture shape profile hash is derived from canonical numeric metadata", () => {
  for (const profile of [OBSERVED_SHAPE_PROFILE_20, OBSERVED_SHAPE_PROFILE_30]) {
    assert.equal(shapeProfileHash(profile), profile.sourceShapeHash);
    const mutated = structuredClone(profile);
    const promptKey = mutated.promptLengthSummary ? "promptLengthSummary" : "observedPromptLengthSummary";
    mutated[promptKey].p50 += 1;
    assert.notEqual(shapeProfileHash(mutated), profile.sourceShapeHash);
  }
});

test("synthetic prompt lengths remain within observed distribution tolerance", () => {
  for (const [fixture, profile] of [
    [fixture20, OBSERVED_SHAPE_PROFILE_20],
    [fixture30, OBSERVED_SHAPE_PROFILE_30],
  ]) {
    const observed = observedShape(profile);
    const actual = summarizeObservedValues(fixture.renderedResults.map((result) =>
      result.workflow.fullVideoPrompt.replace(/\s+/g, "").length));
    assertRelativeTolerance(actual.min, observed.promptLengthSummary.min, 0.15, `${fixture.fixtureId} prompt min`);
    assertRelativeTolerance(actual.p50, observed.promptLengthSummary.p50, 0.10, `${fixture.fixtureId} prompt p50`);
    assertRelativeTolerance(actual.p95, observed.promptLengthSummary.p95, 0.10, `${fixture.fixtureId} prompt p95`);
    assertRelativeTolerance(actual.max, observed.promptLengthSummary.max, 0.15, `${fixture.fixtureId} prompt max`);
  }
});

test("synthetic local workload represents observed patch and finding shape", () => {
  for (const [fixture, profile] of [
    [fixture20, OBSERVED_SHAPE_PROFILE_20],
    [fixture30, OBSERVED_SHAPE_PROFILE_30],
  ]) {
    const observed = observedShape(profile);
    const actual = collectFixtureWorkloadShape(fixture);
    assertRelativeTolerance(actual.patch.total, observed.localPatchSummary.total, 0.10, `${fixture.fixtureId} patch total`);
    assert.ok(Math.abs(actual.patch.p50 - observed.localPatchSummary.p50) <= 1);
    assert.ok(Math.abs(actual.patch.p95 - observed.localPatchSummary.p95) <= 1);
    assert.ok(Math.abs(actual.warning.p50 - observed.findingSummary.warning.p50) <= 1);
    assert.ok(Math.abs(actual.warning.p95 - observed.findingSummary.warning.p95) <= 1);
    assert.ok(Math.abs(actual.risk.p50 - observed.findingSummary.risk.p50) <= 1);
    assert.ok(Math.abs(actual.risk.p95 - observed.findingSummary.risk.p95) <= 1);
    assert.equal(actual.blocking.max, 0);
    assert.equal(actual.patchable.max, 0);

    const replay = runTimedBatchFixtureReplay(
      cloneFixture(fixture),
      createFrozenDashboardLocalAdapter(process.cwd()),
    );
    for (const kind of MODEL_KINDS) assert.equal(replay.invocationCounters[kind].executing, 0);
  }
});

test("fixture result bytes and contract bytes stay representative", () => {
  for (const [fixture, profile] of [
    [fixture20, OBSERVED_SHAPE_PROFILE_20],
    [fixture30, OBSERVED_SHAPE_PROFILE_30],
  ]) {
    const observed = observedShape(profile);
    const resultBytes = summarizeObservedValues(fixture.renderedResults.map((result) =>
      Buffer.byteLength(JSON.stringify(result), "utf8")));
    const contractBytes = summarizeObservedValues(fixture.contracts.map((contract) =>
      compileSegmentContractRenderBlock(contract).byteLength));
    assertRelativeTolerance(resultBytes.p50, observed.resultByteSummary.p50, 0.15, `${fixture.fixtureId} result bytes p50`);
    assertRelativeTolerance(resultBytes.p95, observed.resultByteSummary.p95, 0.15, `${fixture.fixtureId} result bytes p95`);
    assertRelativeTolerance(contractBytes.p50, observed.contractByteSummary.p50, 0.15, `${fixture.fixtureId} contract bytes p50`);
    assertRelativeTolerance(contractBytes.p95, observed.contractByteSummary.p95, 0.15, `${fixture.fixtureId} contract bytes p95`);
    assert.ok(contractBytes.max >= 2_400 && contractBytes.max <= 3_072);
    const manifest = fixture.segmentCount === 20
      ? fixture20Module.FIXTURE_MANIFEST
      : fixture30Module.FIXTURE_MANIFEST;
    for (const [field, expected] of Object.entries(observed.shotFieldLengthSummaries)) {
      const actual = manifest.shotFieldLengthSummaries[field];
      assertRelativeTolerance(actual.p50, expected.p50, 0.15, `${fixture.fixtureId} ${field} p50`);
      assertRelativeTolerance(actual.p95, expected.p95, 0.15, `${fixture.fixtureId} ${field} p95`);
    }
  }
});

test("representative fixtures publish diverse non-content shape manifests", () => {
  for (const [fixture, manifest, minimumScenarios] of [
    [fixture20, fixture20Module.FIXTURE_MANIFEST, 8],
    [fixture30, fixture30Module.FIXTURE_MANIFEST, 12],
  ]) {
    assert.ok(manifest, `${fixture.fixtureId} must export a shape manifest`);
    assert.equal(manifest.fixtureSchemaVersion, 3);
    assert.equal(manifest.fixtureId, fixture.fixtureId);
    assert.equal(manifest.segmentCount, fixture.segmentCount);
    assert.match(manifest.sourceShapeHash, /^[a-f0-9]{64}$/);
    assert.ok(manifest.scenarioCount >= minimumScenarios);
    assert.deepEqual(manifest.shotCountHistogram, fixture.renderedResults.reduce((histogram, result) => {
      const key = String(result.storyboard.length);
      histogram[key] = (histogram[key] || 0) + 1;
      return histogram;
    }, {}));
    assert.ok(manifest.promptLengthSummary.min >= 900);
    assert.ok(manifest.contractByteSummary.max >= 2_400);
    assert.ok(manifest.contractByteSummary.max <= 3_072);
    assert.ok(manifest.safetyPolarityCounts.negatedFact >= 1);
    assert.ok(manifest.safetyPolarityCounts.negativeConstraint >= 1);
    assert.ok(manifest.eventSlotShapeSummary.totalSlots >= fixture.segmentCount);
    assert.ok(Array.isArray(manifest.expectedUniquePatchPaths));
    assert.equal(manifest.shapeAcceptance.passed, true);

    const scenarioCounts = fixture.renderedResults.reduce((counts, result) => {
      const id = result.fixtureSentinel?.scenarioId;
      assert.ok(id, "every synthetic segment must identify its scenario");
      counts[id] = (counts[id] || 0) + 1;
      return counts;
    }, {});
    assert.equal(Object.keys(scenarioCounts).length, manifest.scenarioCount);
    assert.ok(Math.max(...Object.values(scenarioCounts)) <= fixture.segmentCount * 0.25);
  }
  assert.ok(fixture30.renderedResults.some((result) => result.storyboard.length === 5));
});

test("fixture manifest derives workload from live full-pipeline replay", () => {
  for (const [fixture, manifest] of [
    [fixture20, fixture20Module.FIXTURE_MANIFEST],
    [fixture30, fixture30Module.FIXTURE_MANIFEST],
  ]) {
    const replay = runTimedBatchFixtureReplay(
      cloneFixture(fixture),
      createFrozenDashboardLocalAdapter(process.cwd()),
    );
    assert.ok(replay.workloadSummary, "full-pipeline replay must publish deterministic workload summary");
    assert.ok(
      manifest.liveFullPipelineWorkload,
      "fixture manifest must source workload totals from the production replay",
    );
    assert.deepEqual(
      manifest.liveFullPipelineWorkload.findingSummary,
      replay.workloadSummary.findingSummary,
    );
    assert.deepEqual(
      manifest.liveFullPipelineWorkload.localPatchSummary,
      replay.workloadSummary.localPatchSummary,
    );
    assert.deepEqual(
      manifest.liveFullPipelineWorkload.routeDecisionCounts,
      replay.workloadSummary.routeDecisionCounts,
    );
    assert.deepEqual(
      manifest.liveFullPipelineWorkload.modelExecutingCounts,
      replay.workloadSummary.modelExecutingCounts,
    );
  }
});

test("manifest separates observed workload from live production workload", () => {
  for (const [manifest, expectedObserved, expectedLive] of [
    [fixture20Module.FIXTURE_MANIFEST, { warning: 136, risk: 92 }, { warning: 156, risk: 102 }],
    [fixture30Module.FIXTURE_MANIFEST, { warning: 171, risk: 156 }, { warning: 201, risk: 184 }],
  ]) {
    assert.ok(
      manifest.liveFullPipelineWorkload,
      "fixture manifest must separate historical observations from live replay workload",
    );
    assert.equal(manifest.observedShapeProfile.findingSummary.warning.total, expectedObserved.warning);
    assert.equal(manifest.observedShapeProfile.findingSummary.risk.total, expectedObserved.risk);
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.warning.total, expectedLive.warning);
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.risk.total, expectedLive.risk);
    assert.notStrictEqual(manifest.observedShapeProfile, manifest.liveFullPipelineWorkload);
  }
});

test("manifest warning risk and local-patch totals equal live replay totals", () => {
  for (const [fixture, manifest, expected] of [
    [fixture20, fixture20Module.FIXTURE_MANIFEST, { warning: 156, risk: 102, localPatch: 57 }],
    [fixture30, fixture30Module.FIXTURE_MANIFEST, { warning: 201, risk: 184, localPatch: 147 }],
  ]) {
    const replay = runTimedBatchFixtureReplay(
      cloneFixture(fixture),
      createFrozenDashboardLocalAdapter(process.cwd()),
    );
    assert.ok(
      manifest.liveFullPipelineWorkload,
      "fixture manifest must source workload totals from the production replay",
    );
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.warning.total, expected.warning);
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.risk.total, expected.risk);
    assert.equal(manifest.liveFullPipelineWorkload.localPatchSummary.total, expected.localPatch);
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.warning.total, replay.quality.findingCounts.warning);
    assert.equal(manifest.liveFullPipelineWorkload.findingSummary.risk.total, replay.quality.findingCounts.risk);
    assert.equal(manifest.liveFullPipelineWorkload.localPatchSummary.total, replay.quality.localPatchOperations);
  }
});

test("manifest cannot pass when copied observed counts differ from live replay", () => {
  for (const [fixture, manifest] of [
    [fixture20, fixture20Module.FIXTURE_MANIFEST],
    [fixture30, fixture30Module.FIXTURE_MANIFEST],
  ]) {
    const replay = runTimedBatchFixtureReplay(
      cloneFixture(fixture),
      createFrozenDashboardLocalAdapter(process.cwd()),
    );
    assert.notEqual(
      manifest.observedShapeProfile.findingSummary.warning.total,
      replay.quality.findingCounts.warning,
    );
    assert.notEqual(
      manifest.observedShapeProfile.findingSummary.risk.total,
      replay.quality.findingCounts.risk,
    );
    assert.ok(
      Array.isArray(manifest.observedVsLiveDeltas),
      "fixture manifest must disclose observed-versus-live workload deltas",
    );
    assert.ok(
      manifest.observedVsLiveDeltas.some((check) =>
        check.metric === "findingSummary.warning.total" && check.delta !== 0),
    );
    assert.ok(
      manifest.observedVsLiveDeltas.some((check) =>
        check.metric === "findingSummary.risk.total" && check.delta !== 0),
    );
  }
});

test("representative fixtures remain synthetic and privacy-safe", () => {
  const serialized = canonicalizeFixture(collectFixtureContentText({ fixture20, fixture30 }));
  assert.doesNotMatch(serialized, /PRIVATE_/i);
  assert.doesNotMatch(serialized, /[A-Z]:\\\\/);
  assert.doesNotMatch(serialized, /(?:https?:\/\/|localhost:\d+)/i);
  assert.doesNotMatch(serialized, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(serialized, /(?<!\d)1[3-9]\d{9}(?!\d)/);
  assert.doesNotMatch(serialized, /season-pack-job-|project_[a-z0-9-]{8,}/i);
  assert.doesNotMatch(serialized, /(?:undefined|null|ï¿½|�)/i);
});

test("frozen 20- and 30-segment fixtures have stable hashes and complete prompt structure", () => {
  assertFixtureIntegrity(fixture20, FIXTURE_20_SHA256);
  assertFixtureIntegrity(fixture30, FIXTURE_30_SHA256);
});

test("100 deterministic replays keep findings, patches, scores and canonical hashes stable", () => {
  for (const fixture of [fixture20, fixture30]) {
    const first = replayFixture(fixture);
    for (let iteration = 1; iteration < 100; iteration += 1) {
      assert.deepEqual(replayFixture(fixture), first);
    }
    assert.deepEqual(first.acceptedSegmentIndexes, fixture.expected.acceptedSegmentIndexes);
    assert.deepEqual(first.needsReviewSegmentIndexes, fixture.expected.needsReviewSegmentIndexes);
    assert.deepEqual(first.blockingFindingFingerprints, fixture.expected.blockingFindingFingerprints);
    assert.deepEqual(first.uniquePatchPaths, fixture.expected.uniquePatchPaths);
  }
});

test("clean fixture replay invokes no model-backed adapter", () => {
  for (const fixture of [fixture20, fixture30]) {
    const replay = replayFixture(fixture);
    for (const kind of MODEL_KINDS) assert.equal(replay.invocationCounters[kind].executing, 0);
    assert.equal(replay.fullRegenerationCount, 0);
    assert.equal(replay.pathRepairCount, 0);
  }
});

test("frozen replay passes the complete Dashboard quality option snapshot", () => {
  const fixture = cloneFixture(fixture20);
  const baseAdapter = createFrozenDashboardLocalAdapter(process.cwd());
  const snapshots = [];
  const adapter = {
    ...baseAdapter,
    evaluateBatchSegmentQuality(result, options) {
      snapshots.push(structuredClone(options));
      return baseAdapter.evaluateBatchSegmentQuality(result, options);
    },
  };
  runTimedBatchFixtureReplay(fixture, adapter);
  assert.ok(typeof fixture.baseScript === "string" && fixture.baseScript.length > 0);
  assert.ok(snapshots.length >= fixture.segmentCount);
  const snapshot = snapshots[0];
  for (const key of [
    "segmentIndex",
    "expectedShotCount",
    "sourceShotCount",
    "minShotCount",
    "maxShotCount",
    "requestedDuration",
    "contract",
    "coverageDecisions",
    "coverageMode",
    "fullPromptText",
    "minFullPromptLength",
  ]) assert.ok(Object.hasOwn(snapshot, key), `quality options must include ${key}`);
  assert.equal(snapshot.segmentIndex, 1);
  assert.equal(snapshot.expectedShotCount, 4);
  assert.equal(snapshot.sourceShotCount, 4);
  assert.equal(snapshot.minShotCount, 0);
  assert.equal(snapshot.maxShotCount, 5);
  assert.equal(snapshot.requestedDuration, fixture.requestedDuration);
  assert.equal(snapshot.contract.contractHash, fixture.contracts[0].contractHash);
  assert.ok(snapshot.coverageDecisions.length >= 1);
  assert.ok(snapshot.coverageDecisions.every((decision) => decision.status === "covered"));
  assert.equal(snapshot.coverageMode, "shadow");
  assert.ok(snapshot.fullPromptText.length >= 900);
  assert.equal(snapshot.minFullPromptLength, 900);
});

test("coverage validation is included in full local pipeline timing", () => {
  for (const fixture of [fixture20, fixture30]) {
    const replay = runTimedBatchFixtureReplay(
      cloneFixture(fixture),
      createFrozenDashboardLocalAdapter(process.cwd()),
    );
    const expectedCoverageDecisions = fixture.contracts.reduce(
      (total, contract) => total + contract.requiredEventSlots.length,
      0,
    );
    assert.ok(Object.hasOwn(replay.timingsMs, "coverage_validation_total"));
    assert.ok(replay.timingsMs.coverage_validation_total >= 0);
    assert.equal(replay.quality.coverageDecisionCounts.covered, expectedCoverageDecisions);
    assert.equal(replay.quality.coverageDecisionCounts.ambiguous || 0, 0);
    assert.equal(replay.quality.coverageDecisionCounts.definite_missing || 0, 0);
  }
});

test("coverage mutations route to local, Judge and path-repair traps without real jobs", () => {
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());

  const ambiguousShadow = runTimedBatchFixtureReplay(
    createCoverageDecisionFixture("ambiguous", "shadow"),
    adapter,
    { coverageStage: "shadow" },
  );
  assert.equal(ambiguousShadow.quality.routeDecisionCounts.accept, 1);
  assert.equal(ambiguousShadow.invocationCounters.coverage_judge.executing, 0);
  assert.equal(ambiguousShadow.invocationCounters.path_repair.executing, 0);

  assert.throws(
    () => runTimedBatchFixtureReplay(
      createCoverageDecisionFixture("ambiguous", "active"),
      adapter,
      { coverageStage: "judge-active" },
    ),
    (error) => error instanceof UnexpectedBenchmarkModelInvocation
      && error.kind === "coverageJudge",
  );

  assert.throws(
    () => runTimedBatchFixtureReplay(
      createCoverageDecisionFixture("definite_missing", "active"),
      adapter,
      { coverageStage: "patch-active" },
    ),
    (error) => error instanceof UnexpectedBenchmarkModelInvocation
      && error.kind === "pathRepair",
  );
});

test("source shot limits and requested duration affect replay routing", () => {
  for (const shotCount of [3, 4, 5, 6]) {
    const fixture = createShotBoundaryFixture(shotCount);
    const adapter = createFrozenDashboardLocalAdapter(process.cwd());
    if (shotCount === 3 || shotCount === 6) {
      assert.throws(
        () => runTimedBatchFixtureReplay(fixture, adapter),
        (error) => error instanceof UnexpectedBenchmarkModelInvocation
          && error.kind === "singleGeneration",
      );
    } else {
      const replay = runTimedBatchFixtureReplay(fixture, adapter);
      assert.equal(replay.quality.accepted, 1);
      assert.equal(replay.invocationCounters.single_generation.executing, 0);
    }
  }
});

function createShotBoundaryFixture(shotCount) {
  const fixture = cloneFixture(fixture30);
  const sourceResult = fixture.renderedResults.find((result) => result.storyboard.length === 5);
  const storyboard = Array.from({ length: shotCount }, (_, index) => {
    const template = sourceResult.storyboard[index % sourceResult.storyboard.length];
    return {
      ...structuredClone(template),
      shotNumber: index + 1,
      timeRange: `${index * 2}s-${(index + 1) * 2}s`,
    };
  });
  const result = {
    ...structuredClone(sourceResult),
    duration: "15秒",
    storyboard,
  };
  const contract = {
    ...structuredClone(fixture.contracts[0]),
    segmentIndex: 1,
    durationSeconds: 15,
    shotCount,
    requiredEventSlots: [],
    characterLocks: [],
  };
  return {
    ...fixture,
    fixtureId: `shot-boundary-${shotCount}`,
    segmentCount: 1,
    baseScript: "第1段｜合成镜头边界测试\n本段仅声明剧情范围，不声明源镜头。",
    contracts: [contract],
    renderedResults: [result],
    qualityContext: [{ episodeIndex: 1, expectedShotCount: shotCount, minFullPromptLength: 900 }],
    expected: undefined,
  };
}

function createCoverageDecisionFixture(status, coverageMode) {
  const fixture = cloneFixture(fixture20);
  const contract = structuredClone(fixture.contracts[0]);
  const result = structuredClone(fixture.renderedResults[0]);
  const slot = contract.requiredEventSlots[0];
  const decision = {
    segmentIndex: 1,
    slotId: slot.id,
    label: slot.label,
    importance: "blocking",
    status,
    evidencePaths: status === "ambiguous" ? ["storyboard[0].videoPrompt"] : [],
    evidenceQuotes: status === "ambiguous" ? [result.storyboard[0].videoPrompt.slice(0, 32)] : [],
    repairTargets: slot.repairTargets,
    repairPaths: ["storyboard[0].videoPrompt"],
    reasonCode: status === "definite_missing" ? "required_field_empty" : "absence_not_proven",
  };
  return {
    ...fixture,
    fixtureId: `coverage-route-${status}-${coverageMode}`,
    segmentCount: 1,
    contracts: [contract],
    renderedResults: [result],
    qualityContext: [{
      episodeIndex: 1,
      expectedShotCount: contract.shotCount,
      minFullPromptLength: 900,
      coverageSidecar: null,
      coverageDecisions: [decision],
      coverageMode,
    }],
    expected: undefined,
  };
}

test("frozen production adapter is bound to the complete Dashboard pipeline closure", () => {
  const source = extractDashboardProductionSourceFingerprint(process.cwd());
  assert.match(source.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.functionNames, COMPLETE_DASHBOARD_PIPELINE_FUNCTIONS);
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());
  assert.equal(adapter.adapterVersion, FROZEN_DASHBOARD_ADAPTER_VERSION);
  assert.equal(adapter.productionSourceFingerprint, source.fingerprint);
  assert.equal(adapter.adapterVersion, "frozen-dashboard-local-v2");
});

test("Dashboard fingerprint covers copied helpers but ignores unrelated UI", async () => {
  const source = await readFile(path.join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `fingerprint-closure-${process.pid}-${Date.now()}`);
  try {
    await mkdir(path.join(root, "components"), { recursive: true });
    const dashboardPath = path.join(root, "components", "DashboardClient.tsx");
    await writeFile(dashboardPath, source, "utf8");
    const original = extractDashboardProductionSourceFingerprint(root);

    const helperMutation = source.replace(
      'function cleanPromptValue(value: unknown, fallback = "") {',
      'function cleanPromptValue(value: unknown, fallback = "合成回退") {',
    );
    await writeFile(dashboardPath, helperMutation, "utf8");
    const helperChanged = extractDashboardProductionSourceFingerprint(root);
    assert.notEqual(helperChanged.fingerprint, original.fingerprint);

    await writeFile(dashboardPath, `${source}\nconst UnrelatedPhaseZeroUiMarker = "ignored";\n`, "utf8");
    const uiChanged = extractDashboardProductionSourceFingerprint(root);
    assert.equal(uiChanged.fingerprint, original.fingerprint);

    await writeFile(
      dashboardPath,
      source.replace("function sanitizeBatchNegativePrompt", "function omittedBatchNegativePrompt"),
      "utf8",
    );
    assert.throws(
      () => extractDashboardProductionSourceFingerprint(root),
      /sanitizeBatchNegativePrompt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dashboard source fingerprint refuses an incomplete extraction", async () => {
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `fingerprint-${process.pid}-${Date.now()}`);
  try {
    await mkdir(path.join(root, "components"), { recursive: true });
    await writeFile(
      path.join(root, "components", "DashboardClient.tsx"),
      "function buildVideoGenerationPromptText() { return ''; }\n",
      "utf8",
    );
    assert.throws(
      () => extractDashboardProductionSourceFingerprint(root),
      /Cannot fingerprint Dashboard pipeline functions/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark rejects baseline and task pipeline fingerprint drift", async () => {
  const benchmark = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  assert.equal(typeof benchmark.assertMatchingProductionSourceFingerprints, "function");
  assert.doesNotThrow(() => benchmark.assertMatchingProductionSourceFingerprints("same", "same"));
  assert.throws(
    () => benchmark.assertMatchingProductionSourceFingerprints("baseline", "task"),
    /fingerprint differs/i,
  );
});

test("queue candidate discovery reads JSON and selects by createdAt without mutating files", async () => {
  const benchmark = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  assert.equal(typeof benchmark.scanQueueDirectoryReadOnly, "function");
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `queue-read-test-${process.pid}-${Date.now()}`);
  const directory = path.join(root, "legacy-flat");
  const firstPath = path.join(directory, "aaa-late.json");
  const secondPath = path.join(directory, "zzz-old.json");
  const malformedPath = path.join(directory, "malformed.json");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(firstPath, `${JSON.stringify({
      id: "job-late",
      status: "pending",
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      sourceHash: "synthetic-source",
      contractHash: "synthetic-contract",
      segmentIndexes: [1],
    })}\n`, "utf8");
    await writeFile(secondPath, `${JSON.stringify({
      id: "job-old",
      status: "pending",
      createdAt: "2026-07-14T09:00:00.000Z",
      updatedAt: "2026-07-14T09:00:00.000Z",
      sourceHash: "synthetic-source",
      contractHash: "synthetic-contract",
      segmentIndexes: [2],
    })}\n`, "utf8");
    await writeFile(malformedPath, "{not-json}\n", "utf8");
    const before = new Map(
      await Promise.all([firstPath, secondPath, malformedPath].map(async (file) => {
        const fileStat = await stat(file);
        return [file, { mtimeMs: fileStat.mtimeMs, size: fileStat.size }];
      })),
    );

    const oldest = await benchmark.scanQueueDirectoryReadOnly(directory, {
      layout: "legacy_flat_job_scan",
      order: "oldest",
    });
    assert.equal(oldest.selectedJobId, "job-old");
    assert.equal(oldest.selectedCreatedAt, "2026-07-14T09:00:00.000Z");
    assert.equal(oldest.parsedFileCount, 2);
    assert.equal(oldest.invalidFileCount, 1);

    await writeFile(firstPath, `${JSON.stringify({
      id: "job-late",
      status: "pending",
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      sourceHash: "synthetic-source",
      contractHash: "synthetic-contract",
      segmentIndexes: [1],
    })}\n`, "utf8");
    const beforeSecondScan = new Map(
      await Promise.all([firstPath, secondPath, malformedPath].map(async (file) => {
        const fileStat = await stat(file);
        return [file, { mtimeMs: fileStat.mtimeMs, size: fileStat.size }];
      })),
    );
    const changed = await benchmark.scanQueueDirectoryReadOnly(directory, {
      layout: "legacy_flat_job_scan",
      order: "oldest",
    });
    assert.equal(changed.selectedJobId, "job-late");
    assert.equal(changed.selectedCreatedAt, "2026-07-14T08:00:00.000Z");
    assert.equal(changed.candidateCount, 2);
    assert.ok(changed.candidatePayloadBytes > 0);
    assert.equal((await readdir(directory)).some((name) => /lock/i.test(name)), false);
    for (const [file, snapshot] of beforeSecondScan) {
      const after = await stat(file);
      assert.deepEqual({ mtimeMs: after.mtimeMs, size: after.size }, snapshot);
    }
    assert.notDeepEqual(before.get(firstPath), beforeSecondScan.get(firstPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue benchmark parses 0/100/500/1000 candidates for both layouts and cleans up", async () => {
  const benchmark = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  assert.equal(typeof benchmark.benchmarkReadOnlyQueueScans, "function");
  const outputRoot = path.join(process.cwd(), ".tmp-batch-benchmark", `queue-benchmark-test-${process.pid}`);
  const runId = "regression";
  await rm(outputRoot, { recursive: true, force: true });
  try {
    const result = await benchmark.benchmarkReadOnlyQueueScans(outputRoot, 1, 0, {
      runId,
      payloadProfile: {
        fileStorePending: { p50: 512, p95: 768 },
        legacyFlat: { p50: 384, p95: 640 },
      },
    });
    for (const count of [0, 100, 500, 1000]) {
      assert.ok(result.timingsMs[`queue_claim_${count}`]);
      const fileStore = result.extensions.layouts.file_store_pending_scan[String(count)];
      const legacy = result.extensions.layouts.legacy_flat_job_scan[String(count)];
      assert.equal(fileStore.parsedFileCount, count);
      assert.equal(legacy.parsedFileCount, count);
      assert.equal(fileStore.invalidFileCount, 1);
      assert.equal(legacy.invalidFileCount, 1);
      assert.equal(fileStore.queueLayout, "file_store_pending_scan");
      assert.equal(legacy.queueLayout, "legacy_flat_job_scan");
    }
    await assert.rejects(
      stat(path.join(outputRoot, `queue-scan-${runId}`)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("canonical prompt hashes are computed from live frozen output, not fixture archive hashes", () => {
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());
  const originalFixture = cloneFixture(fixture20);
  const originalStoredHash = originalFixture.renderedResults[0].workflow.canonicalHash;
  const originalReplay = runTimedBatchFixtureReplay(originalFixture, adapter);
  const mutatedFixture = cloneFixture(fixture20);
  mutatedFixture.renderedResults[0].storyboard[0].visual += "合成变异必须改变现场 canonical 输出。";
  assert.equal(mutatedFixture.renderedResults[0].workflow.canonicalHash, originalStoredHash);

  const mutatedReplay = runTimedBatchFixtureReplay(mutatedFixture, adapter);
  assert.notEqual(
    mutatedReplay.quality.canonicalPromptHashes[0],
    originalReplay.quality.canonicalPromptHashes[0],
  );
  assert.notEqual(originalReplay.quality.canonicalPromptHashes[0], originalStoredHash);
});

test("mutation route reaches explicit model adapter trap and records executing", () => {
  const fixture = cloneFixture(fixture20);
  fixture.renderedResults[2].storyboard = [];
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());
  const observed = [];
  const uninstall = installBatchInvocationObserver((event) => observed.push(event));
  try {
    assert.throws(
      () => runTimedBatchFixtureReplay(fixture, adapter, {
        modelAdapters: createThrowingBenchmarkModelAdapters({ batchId: "fixture:mutation" }),
      }),
      UnexpectedBenchmarkModelInvocation,
    );
  } finally {
    uninstall();
  }
  const counters = summarizeBatchInvocations(observed);
  assert.equal(counters.single_generation.executing, 1);
});

test("deterministic patch leaves unmatched result fields byte-identical", () => {
  const fixture = cloneFixture(fixture20);
  const raw = fixture.renderedResults[0];
  const before = JSON.stringify({
    diagnosis: raw.diagnosis,
    optimizedScript: raw.optimizedScript,
    concisePrompt: raw.workflow.concisePrompt,
    shotPurposes: raw.storyboard.map((shot) => shot.shotPurpose),
    fixtureSentinel: raw.fixtureSentinel,
  });
  const gate = evaluateBatchSegmentQuality(raw, {
    ...fixture.qualityContext[0],
    contract: fixture.contracts[0],
    fullPromptText: raw.workflow.fullVideoPrompt,
  });
  const patched = applyDeterministicQualityPatchWithDiff(
    raw,
    selectDeterministicQualityPatchFindings(gate.findings, { safetyEnabled: true }),
  );
  const after = JSON.stringify({
    diagnosis: patched.result.diagnosis,
    optimizedScript: patched.result.optimizedScript,
    concisePrompt: patched.result.workflow.concisePrompt,
    shotPurposes: patched.result.storyboard.map((shot) => shot.shotPurpose),
    fixtureSentinel: patched.result.fixtureSentinel,
  });

  assert.equal(after, before);
});

test("real-artifact analyzer is read-only, redacts prompt bodies and preserves unknown timings", async () => {
  const { analyzeBatchJobArtifacts, validateArtifactRoot } = await import(
    "../scripts/analyze-batch-job-artifacts.mjs"
  );
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `artifact-test-${process.pid}-${Date.now()}`);
  const queueRoot = path.join(root, ".tmp-video-prompt-pack-codex");
  const resultRoot = path.join(queueRoot, "results");
  const cacheRoot = path.join(root, ".tmp-segment-batch-cache");
  const excludedEvidenceRoot = path.join(root, ".tmp-task-one-evidence");
  const outputPath = path.join(excludedEvidenceRoot, "analysis", "report.json");
  const sourceFiles = [];

  async function writeJson(target, value) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    sourceFiles.push(target);
  }

  const baseJob = {
    status: "completed",
    taskClass: "render_pack",
    sourceHash: "synthetic-source",
    contractHash: "synthetic-contract",
    segmentIndexes: [1, 2],
    createdAt: "2026-07-13T00:00:00.000Z",
    waitingSlotAt: "2026-07-13T00:00:01.000Z",
    executingAt: "2026-07-13T00:00:02.000Z",
    codexExitedAt: "2026-07-13T00:00:05.000Z",
    completedAt: "2026-07-13T00:00:06.000Z",
  };
  try {
    await writeJson(path.join(queueRoot, "completed", "job-complete.json"), {
      ...baseJob,
      id: "job-complete",
    });
    await writeJson(path.join(queueRoot, "completed", "job-duplicate.json"), {
      ...baseJob,
      id: "job-duplicate",
      completedAt: "2026-07-13T00:00:07.000Z",
    });
    await writeJson(path.join(queueRoot, "completed", "job-identity.json"), {
      ...baseJob,
      id: "job-identity",
      segmentIndexes: [2],
    });
    await writeJson(path.join(queueRoot, "completed", "job-orphan.json"), {
      ...baseJob,
      id: "job-orphan",
      sourceHash: "orphan-source",
      contractHash: "orphan-contract",
      segmentIndexes: [3],
    });
    await writeJson(path.join(queueRoot, "completed", "job-recent.json"), {
      ...baseJob,
      id: "job-recent",
      sourceHash: "orphan-source",
      contractHash: "orphan-contract",
      segmentIndexes: [4],
    });
    await writeJson(path.join(queueRoot, "completed", "job-incomplete.json"), {
      ...baseJob,
      id: "job-incomplete",
      contractHash: "",
      segmentIndexes: [],
    });
    await writeJson(path.join(queueRoot, "failed", "job-stable-error.json"), {
      ...baseJob,
      id: "job-stable-error",
      status: "failed",
      errorCode: "CODEX_TIMEOUT",
      error: "timeout while waiting for synthetic worker",
      completedAt: "2026-07-13T00:00:08.000Z",
    });
    await writeJson(path.join(queueRoot, "failed", "job-first-line.json"), {
      ...baseJob,
      id: "job-first-line",
      status: "failed",
      error: "PRIVATE_ERROR_PROMPT_MARKER must never appear in analyzer output\nsecond line",
      completedAt: "2026-07-13T00:00:09.000Z",
    });
    await writeJson(path.join(queueRoot, "running", "job-unknown-time.json"), {
      id: "job-unknown-time",
      status: "running",
      taskClass: "render_pack",
      sourceHash: "running-source",
      contractHash: "running-contract",
      segmentIndexes: [4],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await writeJson(path.join(queueRoot, "completed", "job-worker-started.json"), {
      id: "job-worker-started",
      status: "completed",
      taskClass: "render_pack",
      sourceHash: "worker-started-source",
      contractHash: "worker-started-contract",
      segmentIndexes: [5],
      createdAt: "2026-07-13T00:00:00.000Z",
      startedAt: "2026-07-13T00:00:03.000Z",
      completedAt: "2026-07-13T00:00:07.000Z",
    });
    const identityReferencedResult = {
      episodeIndex: 2,
      title: "身份引用合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_IDENTITY_PROMPT_MARKER" },
    };
    const completeResult = path.join(resultRoot, "job-complete", "episode-001.json");
    await writeJson(completeResult, {
      jobId: "job-complete",
      title: "合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_PROMPT_MARKER" },
    });
    const identityResultPath = path.join(resultRoot, "job-identity", "episode-002.json");
    await writeJson(identityResultPath, identityReferencedResult);
    const orphanResultPath = path.join(resultRoot, "job-orphan", "episode-003.json");
    await writeJson(orphanResultPath, {
      title: "孤立合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_ORPHAN_PROMPT_MARKER" },
    });
    const recentResultPath = path.join(resultRoot, "job-recent", "episode-004.json");
    await writeJson(recentResultPath, {
      episodeIndex: 4,
      title: "近期合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_RECENT_PROMPT_MARKER" },
    });
    const incompleteResultPath = path.join(resultRoot, "job-incomplete", "episode-006.json");
    await writeJson(incompleteResultPath, {
      title: "身份不完整合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_INCOMPLETE_PROMPT_MARKER" },
    });
    const resultWithoutJobPath = path.join(resultRoot, "job-result-without-job", "episode-007.json");
    await writeJson(resultWithoutJobPath, {
      jobId: "job-result-without-job",
      status: "completed",
      sourceHash: "no-cache-source",
      contractHash: "no-cache-contract",
      segmentIndex: 7,
      title: "无任务结果",
      workflow: { fullVideoPrompt: "PRIVATE_RESULT_WITHOUT_JOB_MARKER" },
    });
    await writeJson(path.join(cacheRoot, "batch-fixture.json"), {
      schemaVersion: 2,
      revision: 3,
      batchId: "batch-fixture",
      durableBatchId: "batch-fixture",
      sourceHash: "synthetic-source",
      contractHash: "synthetic-contract",
      resolvedSegmentCount: 4,
      updatedAt: "2026-07-13T00:00:10.000Z",
      segmentStates: [{ index: 1, activeRepairJobId: "job-worker-started" }],
      activeJobIds: ["job-complete"],
      qualityReports: [],
      segments: [{ episodeIndex: 2, status: "cached", result: identityReferencedResult }],
      needsReviewSegments: [],
      invocationEvents: [
        { name: "renderPackCalls", at: 1, count: 2, jobId: "job-complete" },
        { name: "singleRegenerationCalls", at: 2, count: 1 },
        { name: "pathPatchJobCreated", at: 3, count: 3 },
        { name: "judgeCalls", at: 4, count: 1 },
        { name: "localPatchOperations", at: 5, count: 4 },
      ],
    });
    await writeJson(path.join(cacheRoot, "batch-orphan-scope.json"), {
      schemaVersion: 2,
      revision: 1,
      batchId: "batch-orphan-scope",
      durableBatchId: "batch-orphan-scope",
      sourceHash: "orphan-source",
      contractHash: "orphan-contract",
      resolvedSegmentCount: 4,
      updatedAt: "2026-07-13T00:00:10.000Z",
      segmentStates: [],
      activeJobIds: [],
      qualityReports: [],
      segments: [],
      needsReviewSegments: [],
      invocationEvents: [],
    });
    await writeJson(path.join(cacheRoot, "old-analyzer-report.json"), {
      schemaVersion: 1,
      arbitrary: { jobId: "job-orphan" },
      prompt: "PRIVATE_STALE_REPORT_MARKER",
    });
    await writeJson(path.join(excludedEvidenceRoot, "old-report.json"), {
      status: "completed",
      taskClass: "render_pack",
      id: "excluded-fake-job",
      jobId: "job-orphan",
      prompt: "PRIVATE_EXCLUDED_EVIDENCE_MARKER",
    });
    const referenceTime = Date.now();
    await utimes(completeResult, new Date("2026-07-13T00:00:20.000Z"), new Date("2026-07-13T00:00:20.000Z"));
    await utimes(identityResultPath, new Date(referenceTime - 30 * 60_000), new Date(referenceTime - 30 * 60_000));
    await utimes(orphanResultPath, new Date(referenceTime - 20 * 60_000), new Date(referenceTime - 20 * 60_000));
    await utimes(recentResultPath, new Date(referenceTime - 60_000), new Date(referenceTime - 60_000));
    await utimes(incompleteResultPath, new Date(referenceTime - 30 * 60_000), new Date(referenceTime - 30 * 60_000));
    await utimes(resultWithoutJobPath, new Date(referenceTime - 30 * 60_000), new Date(referenceTime - 30 * 60_000));
    const sourceSnapshotsBefore = new Map(
      await Promise.all(
        sourceFiles.map(async (file) => {
          const [fileStat, body] = await Promise.all([stat(file), readFile(file)]);
          return [
            file,
            {
              mtimeMs: fileStat.mtimeMs,
              size: fileStat.size,
              sha256: createHash("sha256").update(body).digest("hex"),
            },
          ];
        }),
      ),
    );

    const firstReport = await analyzeBatchJobArtifacts({ root, outputPath });
    const secondReport = await analyzeBatchJobArtifacts({ root, outputPath });
    const stableProjection = (report) => {
      const value = structuredClone(report);
      delete value.generatedAt;
      return value;
    };
    const report = secondReport;
    const serialized = JSON.stringify({ firstReport, secondReport });

    assert.deepEqual(stableProjection(firstReport), stableProjection(secondReport));
    assert.deepEqual(report.scanRoots, [
      ".tmp-batch-segment-repair-codex",
      ".tmp-event-coverage-codex",
      ".tmp-prompt-safety-codex",
      ".tmp-season-pack-codex",
      ".tmp-segment-batch-cache",
      ".tmp-video-prompt-codex",
      ".tmp-video-prompt-pack-codex",
    ]);
    assert.equal(report.statusCounts.completed, 7);
    assert.equal(report.statusCounts.failed, 2);
    assert.equal(report.statusCounts.running, 1);
    assert.equal(report.failures.CODEX_TIMEOUT, 1);
    assert.equal(Object.keys(report.failures).some((key) => key.startsWith("FIRST_LINE_SHA256:")), true);
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.completedBeforeFinalOutput.some((item) => item.jobId === "job-complete"), true);
    assert.equal(report.resultWithoutJob.some((item) => item.jobId === "job-result-without-job"), true);
    assert.deepEqual(report.completedResultReferenceSummary, {
      referenced: 2,
      orphan: 1,
      unknown: 3,
    });
    assert.equal(
      report.referencedCompletedResults.some(
        (item) => item.jobId === "job-complete" && item.reasonCode === "referenced_exact_job_id",
      ),
      true,
    );
    assert.equal(
      report.referencedCompletedResults.some(
        (item) => item.jobId === "job-identity" && item.reasonCode === "referenced_result_identity",
      ),
      true,
    );
    assert.equal(
      report.orphanCompletedResults.some(
        (item) => item.jobId === "job-orphan" && item.reasonCode === "orphan_unreferenced_complete_identity",
      ),
      true,
    );
    assert.equal(
      report.unknownCompletedResults.some(
        (item) => item.jobId === "job-recent" && item.reasonCode === "unknown_recent_result",
      ),
      true,
    );
    assert.equal(
      report.unknownCompletedResults.some(
        (item) => item.jobId === "job-incomplete" && item.reasonCode === "unknown_incomplete_identity",
      ),
      true,
    );
    assert.equal(
      report.unknownCompletedResults.some(
        (item) => item.jobId === "job-result-without-job" && item.reasonCode === "unknown_no_durable_cache_scope",
      ),
      true,
    );
    assert.equal(
      report.matchingCompletedResults.length,
      report.completedResultReferenceSummary.referenced
        + report.completedResultReferenceSummary.orphan
        + report.completedResultReferenceSummary.unknown,
    );
    assert.equal(
      new Set([
        ...report.referencedCompletedResults,
        ...report.orphanCompletedResults,
        ...report.unknownCompletedResults,
      ].map((item) => item.resultPath)).size,
      report.matchingCompletedResults.length,
    );
    assert.ok(report.timingsByTaskClass.render_pack.queueWaitMs.unknown >= 1);
    assert.ok(report.timingsByTaskClass.render_pack.claimWaitSupplementMs.count >= 1);
    assert.ok(report.timingsByTaskClass.render_pack.workerWallSupplementMs.count >= 1);
    assert.equal(report.modelInvocationCounts.render_pack, 8);
    assert.equal(report.historicalInvocationCounts.renderPackCalls.known, 2);
    assert.equal(report.historicalInvocationCounts.singleRegenerationCalls.known, 1);
    assert.equal(report.historicalInvocationCounts.pathPatchJobCreated.known, 3);
    assert.equal(report.historicalInvocationCounts.judgeCalls.known, 1);
    assert.equal(report.historicalInvocationCounts.localPatchOperations.known, 4);
    assert.equal(report.historicalInvocationCounts.pathPatchCompleted.known, 0);
    assert.ok(report.historicalInvocationCounts.pathPatchCompleted.unknown >= 1);
    assert.doesNotMatch(
      serialized,
      /PRIVATE_[A-Z_]*MARKER/,
    );
    assert.equal(serialized.includes("excluded-fake-job"), false);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).schemaVersion, 1);
    for (const [file, before] of sourceSnapshotsBefore) {
      const [fileStat, body] = await Promise.all([stat(file), readFile(file)]);
      assert.deepEqual(
        {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          sha256: createHash("sha256").update(body).digest("hex"),
        },
        before,
      );
    }

    assert.throws(
      () => validateArtifactRoot(path.parse(root).root, { allowExternalRead: false }),
      /outside E:\\localdirector/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
