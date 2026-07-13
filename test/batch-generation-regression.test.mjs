import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
      result.workflow.fullVideoPrompt.replace(/\s+/g, "").length > 1400,
      `segment ${index + 1} should keep a prompt above 1400 characters`,
    );
  });
  const nearLimit = compileSegmentContractRenderBlock(fixture.contracts.at(-1));
  assert.ok(nearLimit.byteLength >= 2_400 && nearLimit.byteLength <= 3_072);
}

test("representative fixtures publish diverse non-content shape manifests", () => {
  for (const [fixture, manifest, minimumScenarios] of [
    [fixture20, fixture20Module.FIXTURE_MANIFEST, 8],
    [fixture30, fixture30Module.FIXTURE_MANIFEST, 12],
  ]) {
    assert.ok(manifest, `${fixture.fixtureId} must export a shape manifest`);
    assert.equal(manifest.fixtureSchemaVersion, 1);
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

test("representative fixtures remain synthetic and privacy-safe", () => {
  const serialized = canonicalizeFixture({ fixture20, fixture30 });
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

test("frozen production adapter is bound to all four Dashboard pipeline functions", () => {
  const source = extractDashboardProductionSourceFingerprint(process.cwd());
  assert.match(source.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.functionNames, [
    "buildVideoGenerationPromptText",
    "normalizeBatchSegmentResultForQuality",
    "canonicalizeBatchSegmentResult",
    "normalizePatchAndEvaluateBatchSegment",
  ]);
  const adapter = createFrozenDashboardLocalAdapter(process.cwd());
  assert.equal(adapter.adapterVersion, FROZEN_DASHBOARD_ADAPTER_VERSION);
  assert.equal(adapter.productionSourceFingerprint, source.fingerprint);
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
    await writeJson(path.join(queueRoot, "completed", "job-orphan.json"), {
      ...baseJob,
      id: "job-orphan",
      sourceHash: "orphan-source",
      contractHash: "orphan-contract",
      segmentIndexes: [3],
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
    const completeResult = path.join(resultRoot, "job-complete", "episode-001.json");
    await writeJson(completeResult, {
      jobId: "job-complete",
      title: "合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_PROMPT_MARKER" },
    });
    await writeJson(path.join(resultRoot, "job-orphan", "episode-003.json"), {
      jobId: "job-orphan",
      title: "孤立合成结果",
      workflow: { fullVideoPrompt: "PRIVATE_ORPHAN_PROMPT_MARKER" },
    });
    await writeJson(path.join(resultRoot, "job-result-without-job", "episode-004.json"), {
      jobId: "job-result-without-job",
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
      resolvedSegmentCount: 2,
      updatedAt: "2026-07-13T00:00:10.000Z",
      segmentStates: [{ index: 1, activeRepairJobId: "job-worker-started" }],
      activeJobIds: ["job-complete"],
      qualityReports: [],
      segments: [],
      needsReviewSegments: [],
      invocationEvents: [
        { name: "renderPackCalls", at: 1, count: 2, jobId: "job-complete" },
        { name: "singleRegenerationCalls", at: 2, count: 1 },
        { name: "pathPatchJobCreated", at: 3, count: 3 },
        { name: "judgeCalls", at: 4, count: 1 },
        { name: "localPatchOperations", at: 5, count: 4 },
      ],
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
    await utimes(completeResult, new Date("2026-07-13T00:00:20.000Z"), new Date("2026-07-13T00:00:20.000Z"));
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
    assert.equal(report.statusCounts.completed, 4);
    assert.equal(report.statusCounts.failed, 2);
    assert.equal(report.statusCounts.running, 1);
    assert.equal(report.failures.CODEX_TIMEOUT, 1);
    assert.equal(Object.keys(report.failures).some((key) => key.startsWith("FIRST_LINE_SHA256:")), true);
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.completedBeforeFinalOutput.some((item) => item.jobId === "job-complete"), true);
    assert.equal(report.resultWithoutJob.some((item) => item.jobId === "job-result-without-job"), true);
    assert.equal(
      report.matchingCompletedResults.some(
        (item) => item.jobId === "job-orphan" && item.referenceStatus === "unknown",
      ),
      true,
    );
    assert.equal(report.orphanCompletedResults.some((item) => item.jobId === "job-orphan"), false);
    assert.ok(report.timingsByTaskClass.render_pack.queueWaitMs.unknown >= 1);
    assert.ok(report.timingsByTaskClass.render_pack.claimWaitSupplementMs.count >= 1);
    assert.ok(report.timingsByTaskClass.render_pack.workerWallSupplementMs.count >= 1);
    assert.equal(report.modelInvocationCounts.render_pack, 5);
    assert.equal(report.historicalInvocationCounts.renderPackCalls.known, 2);
    assert.equal(report.historicalInvocationCounts.singleRegenerationCalls.known, 1);
    assert.equal(report.historicalInvocationCounts.pathPatchJobCreated.known, 3);
    assert.equal(report.historicalInvocationCounts.judgeCalls.known, 1);
    assert.equal(report.historicalInvocationCounts.localPatchOperations.known, 4);
    assert.equal(report.historicalInvocationCounts.pathPatchCompleted.known, 0);
    assert.ok(report.historicalInvocationCounts.pathPatchCompleted.unknown >= 1);
    assert.doesNotMatch(
      serialized,
      /PRIVATE_(?:ERROR|ORPHAN_|RESULT_WITHOUT_JOB_|STALE_REPORT_|EXCLUDED_EVIDENCE_)?(?:PROMPT_)?MARKER/,
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
