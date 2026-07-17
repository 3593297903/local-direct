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
  summarizeNumericSamples,
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

const REQUIRED_EXTERNAL_COMMAND_IDS = [
  "focused-tests",
  "benchmark-20",
  "benchmark-30",
  "artifact-analysis-1",
  "artifact-analysis-2",
  "typecheck",
  "api-typecheck",
  "full-tests",
  "api-build",
  "frontend-build",
  "privacy-safe",
  "git-diff-check",
  "git-status-clean",
  "git-ancestor",
  "git-merge-tree",
];

const ALLOWED_POSTGRES_SKIP =
  "twenty concurrent PostgreSQL saves create one version and replay the same ids";

let externalVerificationFixtureSequence = 0;

async function createExternalVerificationFixture() {
  externalVerificationFixtureSequence += 1;
  const root = path.join(
    process.cwd(),
    ".tmp-batch-benchmark",
    `external-verification-${process.pid}-${externalVerificationFixtureSequence}`,
  );
  const logsRoot = path.join(root, "logs");
  await mkdir(logsRoot, { recursive: true });
  const commands = [];
  for (const commandId of REQUIRED_EXTERNAL_COMMAND_IDS) {
    const logPath = `logs/${commandId}.log`;
    const logBody = `${commandId}: verified\n`;
    await writeFile(path.join(root, logPath), logBody, "utf8");
    const summary = {};
    if (commandId === "focused-tests") {
      summary.testSummary = { tests: 33, pass: 33, fail: 0, skipped: 0, skippedTests: [] };
    }
    if (commandId === "full-tests") {
      summary.testSummary = {
        tests: 509,
        pass: 508,
        fail: 0,
        skipped: 1,
        skippedTests: [ALLOWED_POSTGRES_SKIP],
      };
    }
    if (commandId === "privacy-safe") {
      summary.privacySafe = true;
      summary.testSummary = { tests: 1, pass: 1, fail: 0, skipped: 0, skippedTests: [] };
    }
    if (commandId === "git-diff-check" || commandId === "git-status-clean") summary.clean = true;
    if (commandId === "git-ancestor") summary.isAncestor = true;
    if (commandId === "git-merge-tree") summary.treeHash = "a".repeat(40);
    commands.push({
      commandId,
      argv: [commandId],
      exitCode: 0,
      passed: true,
      logPath,
      logSha256: createHash("sha256").update(logBody, "utf8").digest("hex"),
      summary,
    });
  }
  return {
    root,
    document: {
      schemaVersion: 1,
      taskCommit: "task-commit",
      baselineCommit: "baseline-commit",
      commands,
    },
  };
}

async function evaluateExternalVerificationFixture(root, externalVerification) {
  const {
    evaluateRequiredChecks,
    validateExternalVerification,
  } = await import("../scripts/finalize-task-one-phase-0r.mjs");
  assert.equal(
    typeof validateExternalVerification,
    "function",
    "phase-zero finalizer must expose strict external verification validation",
  );
  const validation = await validateExternalVerification({
    evidenceRoot: root,
    externalVerification,
    expectedTaskCommit: "task-commit",
    expectedBaselineCommit: "baseline-commit",
  });
  return {
    validation,
    acceptance: evaluateRequiredChecks(validation.checks),
  };
}

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

test("phase-zero acceptance JSON is UTF-8 without BOM and JSON.parse compatible", async () => {
  const { writeJsonEvidence } = await import("../scripts/finalize-task-one-phase-0r.mjs");
  const root = path.join(
    process.cwd(),
    ".tmp-batch-benchmark",
    `phase-zero-json-${process.pid}-${Date.now()}`,
  );
  const target = path.join(root, "acceptance.json");
  try {
    await mkdir(root, { recursive: true });
    await writeJsonEvidence(target, { schemaVersion: 1, status: "accepted" });
    const bytes = await readFile(target);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.equal(text.trimStart()[0], "{");
    assert.deepEqual(JSON.parse(text), { schemaVersion: 1, status: "accepted" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("any required false check forces acceptance status rejected", async () => {
  const { evaluateRequiredChecks } = await import("../scripts/finalize-task-one-phase-0r.mjs");
  const acceptance = evaluateRequiredChecks([
    { id: "required-pass", required: true, passed: true },
    { id: "required-fail", required: true, passed: false },
    { id: "informational", required: false, passed: false },
  ]);
  assert.equal(acceptance.status, "rejected");
  assert.deepEqual(acceptance.failedRequiredCheckIds, ["required-fail"]);
});

test("benchmark commit or production fingerprint mismatch forces rejected", async () => {
  const {
    buildBenchmarkIdentityChecks,
    evaluateRequiredChecks,
  } = await import("../scripts/finalize-task-one-phase-0r.mjs");
  const checks = buildBenchmarkIdentityChecks({
    gitCommit: "task-mismatch",
    fixtureHash: "fixture-ok",
    baseline: { gitCommit: "baseline-ok" },
    extensions: {
      adapterVersion: "adapter-ok",
      productionSourceFingerprint: "fingerprint-mismatch",
    },
  }, {
    taskCommit: "task-ok",
    baselineCommit: "baseline-ok",
    fixtureHash: "fixture-ok",
    adapterVersion: "adapter-ok",
    productionSourceFingerprint: "fingerprint-ok",
  }, "fixture-20");
  const acceptance = evaluateRequiredChecks(checks);
  assert.equal(acceptance.status, "rejected");
  assert.deepEqual(acceptance.failedRequiredCheckIds, [
    "fixture-20.gitCommit",
    "fixture-20.productionSourceFingerprint",
  ]);
});

const PHASE_THREE_COMMAND_IDS = [
  "phase-three-focused-tests",
  "phase-two-regression-tests",
  "contract-preflight-benchmark",
  "phase-two-lifecycle-benchmark",
  "benchmark-20",
  "benchmark-30",
  "typecheck",
  "api-typecheck",
  "full-tests",
  "api-build",
  "frontend-build",
  "git-diff-check",
  "git-status-clean",
  "git-ancestor",
  "git-merge-tree",
];

function createPhaseThreeContractTimingFixture() {
  const rawSamplesMs = Array.from({ length: 1_000 }, () => 50);
  const trials = Array.from({ length: 5 }, (_, index) => ({
    trialIndex: index + 1,
    sampleCount: 200,
    p50: 50,
    p95: 50,
    mean: 50,
    max: 50,
  }));
  const rawTimingsMs = {
    count: 1_000,
    min: 50,
    p50: 50,
    p95: 50,
    p99: 50,
    max: 50,
    mean: 50,
    standardDeviation: 0,
    coefficientOfVariation: 0,
  };
  return {
    benchmarkVersion: "phase-3-contract-preflight-v2",
    totalIterations: 1_000,
    trialCount: 5,
    iterationsPerTrial: 200,
    globalWarmups: 30,
    rawSamplesMs,
    rawTimingsMs,
    trials,
    stability: {
      metric: "trial_mean_coefficient_of_variation_v1",
      trialCount: 5,
      iterationsPerTrial: 200,
      totalSampleCount: 1_000,
      trialMeans: [50, 50, 50, 50, 50],
      meanOfTrialMeans: 50,
      standardDeviationOfTrialMeans: 0,
      coefficientOfVariation: 0,
    },
    sampleDigest: createHash("sha256").update(JSON.stringify(rawSamplesMs), "utf8").digest("hex"),
    trialDigest: createHash("sha256").update(JSON.stringify(trials), "utf8").digest("hex"),
    sampleConservation: {
      expectedSampleCount: 1_000,
      rawSampleCount: 1_000,
      trialSampleCount: 1_000,
      preserved: true,
    },
    timingsMs: { ...rawTimingsMs },
  };
}

function createPairedQualityTimingPairs({
  pairCount = 400,
  baselineForPair = () => 50,
  taskForPair = (_pairIndex, baselineMs) => baselineMs,
} = {}) {
  return Array.from({ length: pairCount }, (_, index) => {
    const pairIndex = index + 1;
    const baselineMs = baselineForPair(pairIndex);
    return {
      pairIndex,
      order: pairIndex % 2 === 1 ? "baseline_first" : "task_first",
      baselineMs,
      taskMs: taskForPair(pairIndex, baselineMs),
    };
  });
}

async function createPhaseThreeAcceptanceFixture() {
  const {
    evaluatePairedQualityPerformance,
    summarizePairedQualityTimingTrials,
  } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const taskCommit = "a".repeat(40);
  const baselineCommit = "b".repeat(40);
  const replay20 = replayFixture(fixture20);
  const replay30 = replayFixture(fixture30);
  const zeroCalls = {
    model: 0,
    judge: 0,
    repair: 0,
    fallback: 0,
    singleGeneration: 0,
  };
  const qualityReport = (count, fixtureHash, canonicalPromptHashes, localPatchOperations) => ({
    schemaVersion: 1,
    gitCommit: taskCommit,
    fixtureHash,
    baseline: { gitCommit: baselineCommit },
    quality: {
      accepted: count,
      blocked: 0,
      needsReview: 0,
      localPatchOperations,
      promptLengths: { min: 1_800 },
    },
    extensions: {
      canonicalPromptHashes,
      localPatchOperations,
      queueScanStatus: "skipped_unchanged_scope",
    },
    invocationCounters: Object.fromEntries(MODEL_KINDS.map((kind) => [kind, {
      planned: 0,
      created: 0,
      executing: 0,
      completed: 0,
      failed: 0,
    }])),
    timingsMs: { full_local_pipeline_total: { p50: 10, p95: 12, coefficientOfVariation: 0.1 } },
    comparison: { full_local_pipeline_total: { p50Ratio: 1, p95Ratio: 1 } },
    environment: { queueScan: "skipped" },
  });
  const fixture = {
    taskCommit,
    baselineCommit,
    sourceFingerprint: "e".repeat(64),
    reports: {
      contractPreflight: {
        schemaVersion: 1,
        ...createPhaseThreeContractTimingFixture(),
        gitCommit: taskCommit,
        sourceFingerprint: "e".repeat(64),
        contracts: 30,
        iterations: 1000,
        metrics: { attempts: 30, invalid: 0 },
        representativeContractSets: {
          "20": {
            contractCount: 20,
            statusHistogram: { ready: 19, compacted: 1, invalid: 0, overflow: 0 },
            maxByteLength: 2_400,
            semanticDigest: "f".repeat(64),
          },
          "30": {
            contractCount: 30,
            statusHistogram: { ready: 28, compacted: 2, invalid: 0, overflow: 0 },
            maxByteLength: 2_900,
            semanticDigest: "1".repeat(64),
          },
        },
        calls: zeroCalls,
        operationCountBeforePreflight: 0,
        canceledValidNeighbors: 0,
        tamperedQueueCreates: 0,
        semanticDigestStable: true,
        sourceMutationCount: 0,
      },
      lifecycle: {
        status: "accepted",
        maxActive: 4,
        starvationCount: 0,
        lockTimeoutCount: 0,
        calls: zeroCalls,
      },
      benchmark20: qualityReport(
        20,
        FIXTURE_20_SHA256,
        replay20.canonicalPromptHashes,
        57,
      ),
      benchmark30: qualityReport(
        30,
        FIXTURE_30_SHA256,
        replay30.canonicalPromptHashes,
        147,
      ),
    },
    commandResults: {
      schemaVersion: 1,
      taskCommit,
      baselineCommit,
      commands: PHASE_THREE_COMMAND_IDS.map((commandId) => ({
        commandId,
        exitCode: 0,
        passed: true,
        summary: commandId === "git-merge-tree" ? { treeHash: "c".repeat(40) } : {},
      })),
    },
    git: {
      branch: "task-quality-pipeline-fix",
      statusShort: "",
      diffCheckExitCode: 0,
      ancestorExitCode: 0,
      mergeTreeExitCode: 0,
      mergeTreeHash: "c".repeat(40),
      changedFiles: ["scripts/finalize-task-one-phase-3.mjs"],
    },
  };
  for (const report of [fixture.reports.benchmark20, fixture.reports.benchmark30]) {
    const rawPairs = createPairedQualityTimingPairs();
    const pairedTimingEvidence = summarizePairedQualityTimingTrials(
      rawPairs,
      { trialCount: 5, pairsPerTrial: 80 },
    );
    const baselineAggregate = summarizeNumericSamples(rawPairs.map((pair) => pair.baselineMs));
    const taskAggregate = summarizeNumericSamples(rawPairs.map((pair) => pair.taskMs));
    report.qualityBenchmarkVersion = "phase-3-quality-paired-v1";
    report.pairedTimingEvidence = pairedTimingEvidence;
    report.timingsMs.full_local_pipeline_total = { ...taskAggregate };
    report.baseline.timingsMs = {
      full_local_pipeline_total: { ...baselineAggregate },
    };
    report.comparison.full_local_pipeline_total = {
      baselineP50: baselineAggregate.p50,
      baselineP95: baselineAggregate.p95,
      taskP50: taskAggregate.p50,
      taskP95: taskAggregate.p95,
      p50Ratio: taskAggregate.p50 / baselineAggregate.p50,
      p95Ratio: taskAggregate.p95 / baselineAggregate.p95,
    };
    report.performanceAcceptance = evaluatePairedQualityPerformance({
      comparison: report.comparison,
      pairedTimingEvidence,
      invariantPassed: true,
      qualityPassed: true,
    });
  }
  return fixture;
}

test("phase-three contract benchmark runs the production preflight without mutation", async () => {
  const { runContractPreflightBenchmark } = await import("../scripts/benchmark-phase-3-contract-preflight.mjs");
  const report = await runContractPreflightBenchmark({
    contracts: 30,
    iterations: 10,
    trials: 5,
    warmups: 1,
  });
  assert.equal(report.benchmarkVersion, "phase-3-contract-preflight-v2");
  assert.equal(report.contracts, 30);
  assert.equal(report.totalIterations, 10);
  assert.equal(report.trialCount, 5);
  assert.equal(report.iterationsPerTrial, 2);
  assert.equal(report.rawSamplesMs.length, 10);
  assert.equal(report.rawTimingsMs.count, 10);
  assert.equal(report.trials.length, 5);
  assert.equal(report.trials.reduce((total, trial) => total + trial.sampleCount, 0), 10);
  assert.match(report.sampleDigest, /^[a-f0-9]{64}$/);
  assert.match(report.trialDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.metrics.attempts, 30);
  assert.equal(report.metrics.invalid, 0);
  assert.equal(report.semanticDigestStable, true);
  assert.equal(report.sourceMutationCount, 0);
  for (const segmentCount of ["20", "30"]) {
    const representative = report.representativeContractSets[segmentCount];
    assert.equal(representative.contractCount, Number(segmentCount));
    assert.equal(representative.statusHistogram.invalid, 0);
    assert.equal(representative.statusHistogram.overflow, 0);
    assert.equal(
      representative.statusHistogram.ready + representative.statusHistogram.compacted,
      Number(segmentCount),
    );
    assert.ok(representative.maxByteLength <= 3_072);
  }
  assert.deepEqual(report.calls, {
    model: 0,
    judge: 0,
    repair: 0,
    fallback: 0,
    singleGeneration: 0,
  });
});

test("contract timing trials preserve every sample and isolate a single long tail", async () => {
  const { summarizeContractTimingTrials } = await import("../scripts/benchmark-phase-3-contract-preflight.mjs");
  const samples = Array.from({ length: 1_000 }, () => 50);
  samples[199] = 300;

  const summary = summarizeContractTimingTrials(samples, {
    trialCount: 5,
    iterationsPerTrial: 200,
  });

  assert.deepEqual(summary.rawSamplesMs, samples);
  assert.equal(summary.rawTimingsMs.count, 1_000);
  assert.equal(summary.rawTimingsMs.p50, 50);
  assert.equal(summary.rawTimingsMs.p95, 50);
  assert.equal(summary.rawTimingsMs.p99, 50);
  assert.equal(summary.rawTimingsMs.max, 300);
  assert.ok(summary.rawTimingsMs.coefficientOfVariation > 0.15);
  assert.equal(summary.trials.length, 5);
  assert.deepEqual(summary.trials.map((trial) => trial.sampleCount), [200, 200, 200, 200, 200]);
  assert.equal(summary.trials.reduce((total, trial) => total + trial.sampleCount, 0), 1_000);
  assert.ok(summary.stability.coefficientOfVariation <= 0.15);
  assert.match(summary.sampleDigest, /^[a-f0-9]{64}$/);
  assert.match(summary.trialDigest, /^[a-f0-9]{64}$/);
});

test("contract timing trials use deterministic percentiles and preserve sample order in the digest", async () => {
  const { summarizeContractTimingTrials } = await import("../scripts/benchmark-phase-3-contract-preflight.mjs");
  const samples = Array.from({ length: 1_000 }, (_, index) => index + 1);
  const summary = summarizeContractTimingTrials(samples, {
    trialCount: 5,
    iterationsPerTrial: 200,
  });
  const repeated = summarizeContractTimingTrials(samples, {
    trialCount: 5,
    iterationsPerTrial: 200,
  });
  const reversed = summarizeContractTimingTrials([...samples].reverse(), {
    trialCount: 5,
    iterationsPerTrial: 200,
  });

  assert.equal(summary.rawTimingsMs.p50, 500);
  assert.equal(summary.rawTimingsMs.p95, 950);
  assert.equal(summary.rawTimingsMs.p99, 990);
  assert.deepEqual(summary.stability.trialMeans, [100.5, 300.5, 500.5, 700.5, 900.5]);
  assert.equal(summary.sampleDigest, repeated.sampleDigest);
  assert.equal(summary.trialDigest, repeated.trialDigest);
  assert.notEqual(summary.sampleDigest, reversed.sampleDigest);
  assert.notEqual(summary.trialDigest, reversed.trialDigest);
});

test("contract timing trials reject sustained window slowdown and malformed sample conservation", async () => {
  const { summarizeContractTimingTrials } = await import("../scripts/benchmark-phase-3-contract-preflight.mjs");
  const sustainedSlowdown = [
    ...Array.from({ length: 800 }, () => 50),
    ...Array.from({ length: 200 }, () => 100),
  ];
  const summary = summarizeContractTimingTrials(sustainedSlowdown, {
    trialCount: 5,
    iterationsPerTrial: 200,
  });

  assert.ok(summary.stability.coefficientOfVariation > 0.15);
  assert.throws(() => summarizeContractTimingTrials(sustainedSlowdown.slice(1), {
    trialCount: 5,
    iterationsPerTrial: 200,
  }), /sample conservation/i);
  assert.throws(() => summarizeContractTimingTrials([
    ...sustainedSlowdown.slice(0, -1),
    Number.NaN,
  ], {
    trialCount: 5,
    iterationsPerTrial: 200,
  }), /finite non-negative/i);
});

test("paired quality timing preserves all 400 pairs and 5x80 trials", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const pairs = createPairedQualityTimingPairs();
  const summary = summarizePairedQualityTimingTrials(pairs, {
    trialCount: 5,
    pairsPerTrial: 80,
  });

  assert.deepEqual(summary.rawPairs, pairs);
  assert.equal(summary.totalPairs, 400);
  assert.equal(summary.trials.length, 5);
  assert.deepEqual(summary.trials.map((trial) => trial.pairCount), [80, 80, 80, 80, 80]);
  assert.equal(summary.sampleConservation.rawPairCount, 400);
  assert.equal(summary.sampleConservation.baselineSampleCount, 400);
  assert.equal(summary.sampleConservation.taskSampleCount, 400);
  assert.equal(summary.sampleConservation.trialPairCount, 400);
  assert.equal(summary.sampleConservation.preserved, true);
  assert.match(summary.pairDigest, /^[a-f0-9]{64}$/);
  assert.match(summary.trialDigest, /^[a-f0-9]{64}$/);
});

test("paired quality summary matches production interpolation on nonconstant samples", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const pairs = createPairedQualityTimingPairs({
    baselineForPair: (pairIndex) => pairIndex,
  });
  const summary = summarizePairedQualityTimingTrials(pairs, {
    trialCount: 5,
    pairsPerTrial: 80,
  });

  assert.equal(summary.baselineRawTimingsMs.p50, 200.5);
  assert.ok(Math.abs(summary.baselineRawTimingsMs.p95 - 380.05) < 1e-9);
  assert.ok(Math.abs(summary.baselineRawTimingsMs.p99 - 396.01) < 1e-9);
});

test("paired quality evidence matches independently aggregated production samples", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const pairs = createPairedQualityTimingPairs({
    baselineForPair: (pairIndex) => pairIndex + ((pairIndex % 7) / 10),
    taskForPair: (pairIndex, baselineMs) => baselineMs + ((pairIndex % 5) / 100),
  });
  const summary = summarizePairedQualityTimingTrials(pairs, {
    trialCount: 5,
    pairsPerTrial: 80,
  });
  const baselineAggregate = summarizeNumericSamples(pairs.map((pair) => pair.baselineMs));
  const taskAggregate = summarizeNumericSamples(pairs.map((pair) => pair.taskMs));

  for (const [paired, aggregate] of [
    [summary.baselineRawTimingsMs, baselineAggregate],
    [summary.taskRawTimingsMs, taskAggregate],
  ]) {
    for (const key of ["p50", "p95", "max", "mean", "standardDeviation", "coefficientOfVariation"]) {
      assert.equal(paired[key], aggregate[key], key);
    }
  }
});

test("paired quality timing balances execution order in every trial", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const summary = summarizePairedQualityTimingTrials(createPairedQualityTimingPairs(), {
    trialCount: 5,
    pairsPerTrial: 80,
  });

  assert.deepEqual(
    summary.trials.map((trial) => [trial.baselineFirstCount, trial.taskFirstCount]),
    Array.from({ length: 5 }, () => [40, 40]),
  );
  assert.deepEqual(summary.orderConservation, {
    baselineFirstCount: 200,
    taskFirstCount: 200,
    balanced: true,
  });
});

test("paired quality timing records raw CV without using it as the only gate", async () => {
  const {
    evaluatePairedQualityPerformance,
    summarizePairedQualityTimingTrials,
  } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const summary = summarizePairedQualityTimingTrials(createPairedQualityTimingPairs({
    baselineForPair: (pairIndex) => (pairIndex === 1 ? 500 : 50),
  }), {
    trialCount: 5,
    pairsPerTrial: 80,
  });
  const acceptance = evaluatePairedQualityPerformance({
    comparison: { full_local_pipeline_total: { p50Ratio: 1, p95Ratio: 1 } },
    pairedTimingEvidence: summary,
    invariantPassed: true,
    qualityPassed: true,
  });

  assert.ok(summary.baselineRawTimingsMs.coefficientOfVariation > 0.15);
  assert.ok(summary.taskRawTimingsMs.coefficientOfVariation > 0.15);
  assert.equal(acceptance.status, "accepted");
});

test("paired quality timing cancels common-mode whole-trial slowdown", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const summary = summarizePairedQualityTimingTrials(createPairedQualityTimingPairs({
    baselineForPair: (pairIndex) => (pairIndex > 320 ? 100 : 50),
  }), {
    trialCount: 5,
    pairsPerTrial: 80,
  });

  assert.deepEqual(summary.stability.trialRatios, [1, 1, 1, 1, 1]);
  assert.equal(summary.stability.meanRatio, 1);
  assert.equal(summary.stability.coefficientOfVariation, 0);
  assert.equal(summary.stability.maxTrialRatio, 1);
});

test("paired quality timing rejects task-only sustained trial slowdown", async () => {
  const {
    evaluatePairedQualityPerformance,
    summarizePairedQualityTimingTrials,
  } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const summary = summarizePairedQualityTimingTrials(createPairedQualityTimingPairs({
    taskForPair: (pairIndex, baselineMs) => (pairIndex > 320 ? 60 : baselineMs),
  }), {
    trialCount: 5,
    pairsPerTrial: 80,
  });
  const acceptance = evaluatePairedQualityPerformance({
    comparison: { full_local_pipeline_total: { p50Ratio: 1, p95Ratio: 1 } },
    pairedTimingEvidence: summary,
    invariantPassed: true,
    qualityPassed: true,
  });

  assert.equal(summary.stability.maxTrialRatio, 1.2);
  assert.equal(acceptance.status, "rejected");
  assert.ok(acceptance.failedCheckIds.includes("paired.max_trial_ratio"));
});

test("paired quality timing rejects a stable six-percent regression", async () => {
  const {
    evaluatePairedQualityPerformance,
    summarizePairedQualityTimingTrials,
  } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const summary = summarizePairedQualityTimingTrials(createPairedQualityTimingPairs({
    taskForPair: () => 53,
  }), {
    trialCount: 5,
    pairsPerTrial: 80,
  });
  const acceptance = evaluatePairedQualityPerformance({
    comparison: { full_local_pipeline_total: { p50Ratio: 1.06, p95Ratio: 1.06 } },
    pairedTimingEvidence: summary,
    invariantPassed: true,
    qualityPassed: true,
  });

  assert.equal(summary.stability.coefficientOfVariation, 0);
  assert.equal(summary.stability.meanRatio, 1.06);
  assert.equal(acceptance.status, "rejected");
  assert.ok(acceptance.failedCheckIds.includes("comparison.p50_ratio"));
  assert.ok(acceptance.failedCheckIds.includes("comparison.p95_ratio"));
  assert.ok(acceptance.failedCheckIds.includes("paired.mean_ratio"));
});

test("paired quality timing rejects missing reordered or non-finite pairs", async () => {
  const { summarizePairedQualityTimingTrials } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const pairs = createPairedQualityTimingPairs();

  assert.throws(() => summarizePairedQualityTimingTrials(pairs.slice(1), {
    trialCount: 5,
    pairsPerTrial: 80,
  }), /pair conservation/i);
  assert.throws(() => summarizePairedQualityTimingTrials([
    pairs[1],
    pairs[0],
    ...pairs.slice(2),
  ], {
    trialCount: 5,
    pairsPerTrial: 80,
  }), /pairIndex|order/i);
  const nonFinite = structuredClone(pairs);
  nonFinite[10].taskMs = Number.NaN;
  assert.throws(() => summarizePairedQualityTimingTrials(nonFinite, {
    trialCount: 5,
    pairsPerTrial: 80,
  }), /finite positive/i);
});

test("quality benchmark writes a rejected report before returning failure", async () => {
  const { writeQualityBenchmarkReport } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `paired-write-${process.pid}-${Date.now()}`);
  const target = path.join(root, "rejected.json");
  const report = {
    qualityBenchmarkVersion: "phase-3-quality-paired-v1",
    performanceAcceptance: {
      status: "rejected",
      checks: [{ id: "paired.mean_ratio", passed: false, actual: 1.06, limit: 1.05 }],
      failedCheckIds: ["paired.mean_ratio"],
    },
  };
  try {
    await assert.rejects(writeQualityBenchmarkReport(target, report), /paired.mean_ratio/);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase-three finalizer requires paired v1 evidence for both quality reports", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  for (const count of [20, 30]) {
    const oldReport = structuredClone(valid);
    delete oldReport.reports[`benchmark${count}`].qualityBenchmarkVersion;
    delete oldReport.reports[`benchmark${count}`].pairedTimingEvidence;
    delete oldReport.reports[`benchmark${count}`].performanceAcceptance;
    assert.equal(evaluatePhaseThreeAcceptance(oldReport).status, "rejected", `legacy benchmark ${count}`);
  }
});

test("phase-three finalizer independently rejects missing reordered or mutated raw pairs", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  const mutations = [
    ["missing pair", (report) => report.pairedTimingEvidence.rawPairs.pop()],
    ["mutated baseline", (report) => { report.pairedTimingEvidence.rawPairs[0].baselineMs = 51; }],
    ["mutated task", (report) => { report.pairedTimingEvidence.rawPairs[0].taskMs = 51; }],
    ["mutated index", (report) => { report.pairedTimingEvidence.rawPairs[0].pairIndex = 2; }],
    ["mutated order", (report) => { report.pairedTimingEvidence.rawPairs[0].order = "task_first"; }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(valid);
    mutate(forged.reports.benchmark20);
    assert.equal(evaluatePhaseThreeAcceptance(forged).status, "rejected", label);
  }
});

test("phase-three finalizer independently rejects forged conservation digests trials and summaries", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  const mutations = [
    ["order conservation", (report) => { report.pairedTimingEvidence.orderConservation.balanced = false; }],
    ["sample conservation", (report) => { report.pairedTimingEvidence.sampleConservation.rawPairCount = 399; }],
    ["pair digest", (report) => { report.pairedTimingEvidence.pairDigest = "0".repeat(64); }],
    ["trial digest", (report) => { report.pairedTimingEvidence.trialDigest = "0".repeat(64); }],
    ["raw summary", (report) => { report.pairedTimingEvidence.taskRawTimingsMs.p50 = 49; }],
    ["trial ratio", (report) => { report.pairedTimingEvidence.trials[0].taskToBaselineMeanRatio = 0.5; }],
    ["ratio cv", (report) => { report.pairedTimingEvidence.stability.coefficientOfVariation = 0.01; }],
    ["max trial ratio", (report) => { report.pairedTimingEvidence.stability.maxTrialRatio = 1.01; }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(valid);
    mutate(forged.reports.benchmark30);
    assert.equal(evaluatePhaseThreeAcceptance(forged).status, "rejected", label);
  }
});

test("phase-three finalizer verifies top-level paired timing and performance acceptance", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  const mutations = [
    ["task timing", (report) => { report.timingsMs.full_local_pipeline_total.p50 = 49; }],
    ["baseline timing", (report) => { report.baseline.timingsMs.full_local_pipeline_total.p95 = 49; }],
    ["comparison", (report) => { report.comparison.full_local_pipeline_total.p50Ratio = 0.5; }],
    ["acceptance status", (report) => { report.performanceAcceptance.status = "rejected"; }],
    ["acceptance check", (report) => { report.performanceAcceptance.checks[0].passed = false; }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(valid);
    mutate(forged.reports.benchmark20);
    assert.equal(evaluatePhaseThreeAcceptance(forged).status, "rejected", label);
  }

  const concealedRegression = structuredClone(valid);
  const report = concealedRegression.reports.benchmark20;
  for (const pair of report.pairedTimingEvidence.rawPairs) pair.taskMs = pair.baselineMs * 1.06;
  assert.equal(evaluatePhaseThreeAcceptance(concealedRegression).status, "rejected", "concealed regression");
});

test("phase-three finalizer accepts common-mode raw variance but rejects every paired hard gate", async () => {
  const {
    evaluatePairedQualityPerformance,
    summarizePairedQualityTimingTrials,
  } = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const installEvidence = (report, pairs) => {
    const pairedTimingEvidence = summarizePairedQualityTimingTrials(pairs, {
      trialCount: 5,
      pairsPerTrial: 80,
    });
    const baselineAggregate = summarizeNumericSamples(pairs.map((pair) => pair.baselineMs));
    const taskAggregate = summarizeNumericSamples(pairs.map((pair) => pair.taskMs));
    report.pairedTimingEvidence = pairedTimingEvidence;
    report.timingsMs.full_local_pipeline_total = { ...taskAggregate };
    report.baseline.timingsMs.full_local_pipeline_total = { ...baselineAggregate };
    report.comparison.full_local_pipeline_total = {
      baselineP50: baselineAggregate.p50,
      baselineP95: baselineAggregate.p95,
      taskP50: taskAggregate.p50,
      taskP95: taskAggregate.p95,
      p50Ratio: taskAggregate.p50 / baselineAggregate.p50,
      p95Ratio: taskAggregate.p95 / baselineAggregate.p95,
    };
    report.performanceAcceptance = evaluatePairedQualityPerformance({
      comparison: report.comparison,
      pairedTimingEvidence,
      invariantPassed: true,
      qualityPassed: true,
    });
  };

  const commonMode = await createPhaseThreeAcceptanceFixture();
  installEvidence(commonMode.reports.benchmark20, createPairedQualityTimingPairs({
    baselineForPair: (pairIndex) => (pairIndex <= 6 ? 500 : 50),
  }));
  assert.ok(commonMode.reports.benchmark20.pairedTimingEvidence.taskRawTimingsMs.coefficientOfVariation > 0.15);
  assert.equal(evaluatePhaseThreeAcceptance(commonMode).status, "accepted");

  for (const [label, pairs] of [
    ["stable six percent", createPairedQualityTimingPairs({ taskForPair: () => 53 })],
    ["single slow trial", createPairedQualityTimingPairs({
      taskForPair: (pairIndex, baselineMs) => (pairIndex > 320 ? 60 : baselineMs),
    })],
  ]) {
    const regressed = await createPhaseThreeAcceptanceFixture();
    installEvidence(regressed.reports.benchmark30, pairs);
    assert.equal(evaluatePhaseThreeAcceptance(regressed).status, "rejected", label);
  }
});

test("phase-three acceptance rejects missing stale dirty or failed evidence", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  const missingReport = structuredClone(valid);
  delete missingReport.reports.contractPreflight;
  assert.equal(evaluatePhaseThreeAcceptance(missingReport).status, "rejected");

  const staleReport = structuredClone(valid);
  staleReport.reports.benchmark20.gitCommit = "d".repeat(40);
  assert.equal(evaluatePhaseThreeAcceptance(staleReport).status, "rejected");

  const failedCommand = structuredClone(valid);
  failedCommand.commandResults.commands.find((item) => item.commandId === "full-tests").exitCode = 1;
  assert.equal(evaluatePhaseThreeAcceptance(failedCommand).status, "rejected");

  const dirty = structuredClone(valid);
  dirty.git.statusShort = " M components/DashboardClient.tsx";
  assert.equal(evaluatePhaseThreeAcceptance(dirty).status, "rejected");

  const missingQuality30 = structuredClone(valid);
  delete missingQuality30.reports.benchmark30;
  assert.equal(evaluatePhaseThreeAcceptance(missingQuality30).status, "rejected");
});

test("phase-three acceptance requires representative Contract evidence for 20 and 30 segments", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  const missing20 = structuredClone(valid);
  delete missing20.reports.contractPreflight.representativeContractSets["20"];
  assert.equal(evaluatePhaseThreeAcceptance(missing20).status, "rejected");

  const invalid30 = structuredClone(valid);
  invalid30.reports.contractPreflight.representativeContractSets["30"].statusHistogram.invalid = 1;
  invalid30.reports.contractPreflight.representativeContractSets["30"].statusHistogram.ready -= 1;
  assert.equal(evaluatePhaseThreeAcceptance(invalid30).status, "rejected");

  const overflow20 = structuredClone(valid);
  overflow20.reports.contractPreflight.representativeContractSets["20"].statusHistogram.overflow = 1;
  overflow20.reports.contractPreflight.representativeContractSets["20"].statusHistogram.ready -= 1;
  assert.equal(evaluatePhaseThreeAcceptance(overflow20).status, "rejected");

  const incomplete30 = structuredClone(valid);
  incomplete30.reports.contractPreflight.representativeContractSets["30"].statusHistogram.ready -= 1;
  assert.equal(evaluatePhaseThreeAcceptance(incomplete30).status, "rejected");

  const oversized20 = structuredClone(valid);
  oversized20.reports.contractPreflight.representativeContractSets["20"].maxByteLength = 3_073;
  assert.equal(evaluatePhaseThreeAcceptance(oversized20).status, "rejected");
});

test("phase-three acceptance requires v2 trial evidence, digests, and exact sample conservation", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  const oldSchema = structuredClone(valid);
  delete oldSchema.reports.contractPreflight.benchmarkVersion;
  assert.equal(evaluatePhaseThreeAcceptance(oldSchema).status, "rejected");

  const wrongTrialCount = structuredClone(valid);
  wrongTrialCount.reports.contractPreflight.trialCount = 4;
  assert.equal(evaluatePhaseThreeAcceptance(wrongTrialCount).status, "rejected");

  const missingTrial = structuredClone(valid);
  missingTrial.reports.contractPreflight.trials.pop();
  assert.equal(evaluatePhaseThreeAcceptance(missingTrial).status, "rejected");

  const missingSample = structuredClone(valid);
  missingSample.reports.contractPreflight.rawSamplesMs.pop();
  assert.equal(evaluatePhaseThreeAcceptance(missingSample).status, "rejected");

  const forgedConservation = structuredClone(valid);
  forgedConservation.reports.contractPreflight.sampleConservation.rawSampleCount = 999;
  assert.equal(evaluatePhaseThreeAcceptance(forgedConservation).status, "rejected");

  const forgedSampleDigest = structuredClone(valid);
  forgedSampleDigest.reports.contractPreflight.sampleDigest = "0".repeat(64);
  assert.equal(evaluatePhaseThreeAcceptance(forgedSampleDigest).status, "rejected");

  const forgedTrialDigest = structuredClone(valid);
  forgedTrialDigest.reports.contractPreflight.trialDigest = "0".repeat(64);
  assert.equal(evaluatePhaseThreeAcceptance(forgedTrialDigest).status, "rejected");

  const mutatedSample = structuredClone(valid);
  mutatedSample.reports.contractPreflight.rawSamplesMs[0] = 51;
  assert.equal(evaluatePhaseThreeAcceptance(mutatedSample).status, "rejected");

  const wrongMetric = structuredClone(valid);
  wrongMetric.reports.contractPreflight.stability.metric = "trial_mean_cv_legacy";
  assert.equal(evaluatePhaseThreeAcceptance(wrongMetric).status, "rejected");
});

test("phase-three acceptance gates raw tails and trial stability without gating raw CV alone", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const { summarizeContractTimingTrials } = await import("../scripts/benchmark-phase-3-contract-preflight.mjs");
  const installTimingEvidence = (fixture, samples) => {
    const evidence = summarizeContractTimingTrials(samples, {
      trialCount: 5,
      iterationsPerTrial: 200,
    });
    Object.assign(fixture.reports.contractPreflight, evidence, {
      timingsMs: { ...evidence.rawTimingsMs },
    });
  };
  const valid = await createPhaseThreeAcceptanceFixture();
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  for (const [field, samples] of [
    ["p95", Array.from({ length: 1_000 }, (_, index) => (index % 20 === 0 || index === 1 ? 101 : 50))],
    ["p99", Array.from({ length: 1_000 }, (_, index) => (index % 100 === 0 || index === 1 ? 201 : 50))],
    ["max", Array.from({ length: 1_000 }, (_, index) => (index === 0 ? 301 : 50))],
  ]) {
    const exceeded = structuredClone(valid);
    installTimingEvidence(exceeded, samples);
    assert.equal(evaluatePhaseThreeAcceptance(exceeded).status, "rejected", field);
  }

  const unstableTrials = structuredClone(valid);
  installTimingEvidence(unstableTrials, [
    ...Array.from({ length: 800 }, () => 50),
    ...Array.from({ length: 200 }, () => 100),
  ]);
  assert.equal(evaluatePhaseThreeAcceptance(unstableTrials).status, "rejected");

  const diagnosticRawCv = structuredClone(valid);
  installTimingEvidence(diagnosticRawCv, Array.from({ length: 1_000 }, (_, index) => (index === 199 ? 300 : 50)));
  assert.ok(diagnosticRawCv.reports.contractPreflight.rawTimingsMs.coefficientOfVariation > 0.15);
  assert.equal(evaluatePhaseThreeAcceptance(diagnosticRawCv).status, "accepted");

  for (const value of [undefined, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalidRawCv = structuredClone(valid);
    invalidRawCv.reports.contractPreflight.rawTimingsMs.coefficientOfVariation = value;
    assert.equal(evaluatePhaseThreeAcceptance(invalidRawCv).status, "rejected");
  }
});

test("phase-three acceptance allows the refresh recovery regression test in the Phase 3R diff", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  valid.git.changedFiles.push("test/task-one-render-refresh-recovery.test.mjs");
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");
});

test("phase-three acceptance permits only the exact Phase 3R-F test fixture files", async () => {
  const { evaluatePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const valid = await createPhaseThreeAcceptanceFixture();
  valid.git.changedFiles.push(
    "test/helpers/authoritative-render-pack-fixture.mjs",
    "test/codex-finalization-v1-compatibility.test.mjs",
    "test/codex-finalization-v1-migration.test.mjs",
    "test/task-two-render-pack-atomic-claim.test.mjs",
  );
  assert.equal(evaluatePhaseThreeAcceptance(valid).status, "accepted");

  const arbitraryTest = structuredClone(valid);
  arbitraryTest.git.changedFiles.push("test/unrelated-phase-three-file.test.mjs");
  assert.equal(evaluatePhaseThreeAcceptance(arbitraryTest).status, "rejected");

  const unauthorizedProduction = structuredClone(valid);
  unauthorizedProduction.git.changedFiles.push("lib/unrelated-production-change.ts");
  assert.equal(evaluatePhaseThreeAcceptance(unauthorizedProduction).status, "rejected");

  const failedFullTests = structuredClone(valid);
  const fullTests = failedFullTests.commandResults.commands.find((item) => item.commandId === "full-tests");
  fullTests.exitCode = 1;
  fullTests.passed = false;
  assert.equal(evaluatePhaseThreeAcceptance(failedFullTests).status, "rejected");
});

test("phase-three acceptance JSON is UTF-8 without BOM and self-parseable", async () => {
  const { writePhaseThreeAcceptance } = await import("../scripts/finalize-task-one-phase-3.mjs");
  const root = path.join(process.cwd(), ".tmp-batch-benchmark", `phase-three-json-${process.pid}-${Date.now()}`);
  const target = path.join(root, "acceptance.json");
  try {
    const acceptance = await writePhaseThreeAcceptance(target, await createPhaseThreeAcceptanceFixture());
    assert.equal(acceptance.status, "accepted");
    const bytes = await readFile(target);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(JSON.parse(bytes.toString("utf8")).taskCommit, "a".repeat(40));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing external verification forces phase-zero acceptance to rejected", async () => {
  const fixture = await createExternalVerificationFixture();
  try {
    const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, null);
    assert.equal(acceptance.status, "rejected");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("any focused test typecheck full test or build failure forces rejected", async () => {
  for (const commandId of [
    "focused-tests",
    "typecheck",
    "api-typecheck",
    "full-tests",
    "api-build",
    "frontend-build",
  ]) {
    const fixture = await createExternalVerificationFixture();
    try {
      const command = fixture.document.commands.find((entry) => entry.commandId === commandId);
      command.exitCode = 1;
      command.passed = false;
      const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
      assert.equal(acceptance.status, "rejected", commandId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("privacy and every Git hard gate failure force rejected", async () => {
  for (const commandId of [
    "privacy-safe",
    "git-diff-check",
    "git-status-clean",
    "git-ancestor",
    "git-merge-tree",
  ]) {
    const fixture = await createExternalVerificationFixture();
    try {
      const command = fixture.document.commands.find((entry) => entry.commandId === commandId);
      if (commandId === "privacy-safe") command.summary.privacySafe = false;
      if (commandId === "git-diff-check" || commandId === "git-status-clean") command.summary.clean = false;
      if (commandId === "git-ancestor") command.summary.isAncestor = false;
      if (commandId === "git-merge-tree") command.summary.treeHash = "not-a-tree";
      const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
      assert.equal(acceptance.status, "rejected", commandId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("external verification task commit mismatch forces rejected", async () => {
  const fixture = await createExternalVerificationFixture();
  try {
    fixture.document.taskCommit = "different-task-commit";
    const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
    assert.equal(acceptance.status, "rejected");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing escaped or hash-mismatched external logs force rejected", async () => {
  for (const failure of ["missing", "escaped", "hash-mismatch"]) {
    const fixture = await createExternalVerificationFixture();
    try {
      const command = fixture.document.commands[0];
      if (failure === "missing") await rm(path.join(fixture.root, command.logPath), { force: true });
      if (failure === "escaped") command.logPath = "../outside.log";
      if (failure === "hash-mismatch") command.logSha256 = "0".repeat(64);
      const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
      assert.equal(acceptance.status, "rejected", failure);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("missing duplicate or forged external command evidence forces rejected", async () => {
  for (const failure of ["missing", "duplicate", "forged-pass"]) {
    const fixture = await createExternalVerificationFixture();
    try {
      if (failure === "missing") fixture.document.commands.pop();
      if (failure === "duplicate") fixture.document.commands.push(structuredClone(fixture.document.commands[0]));
      if (failure === "forged-pass") {
        fixture.document.commands[0].exitCode = 1;
        fixture.document.commands[0].passed = true;
      }
      const { acceptance } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
      assert.equal(acceptance.status, "rejected", failure);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("valid external verification combines with the existing 94 checks before acceptance", async () => {
  const fixture = await createExternalVerificationFixture();
  try {
    const {
      evaluateRequiredChecks,
    } = await import("../scripts/finalize-task-one-phase-0r.mjs");
    const { validation } = await evaluateExternalVerificationFixture(fixture.root, fixture.document);
    const existingChecks = Array.from({ length: 94 }, (_, index) => ({
      id: `existing-${index + 1}`,
      required: true,
      passed: true,
    }));
    const acceptance = evaluateRequiredChecks([...existingChecks, ...validation.checks]);
    assert.equal(acceptance.status, "accepted");
    assert.equal(acceptance.failedRequiredCheckIds.length, 0);
    assert.ok(acceptance.requiredCheckCount > 94);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
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

test("skip queue scan keeps quality replay scope and never invokes queue benchmarking", async () => {
  const benchmark = await import("../scripts/benchmark-batch-generation-pipeline.mjs");
  let queueBenchmarkCalls = 0;
  const result = await benchmark.resolveQueueBenchmarkForMode({
    skipQueueScan: true,
    outputRoot: "unused",
    iterations: 400,
    warmups: 30,
    benchmarkQueueScans: async () => {
      queueBenchmarkCalls += 1;
      throw new Error("queue benchmark must not run in quality-only mode");
    },
  });
  assert.equal(queueBenchmarkCalls, 0);
  assert.deepEqual(result.timingsMs, {});
  assert.equal(result.extensions.queueScanStatus, "skipped_unchanged_scope");
  assert.deepEqual(result.extensions.layouts, {});
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
