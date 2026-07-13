import assert from "node:assert/strict";
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
  const acceptedSegmentIndexes = [];
  const needsReviewSegmentIndexes = [];
  const blockingFindingFingerprints = [];
  const uniquePatchPaths = new Set();
  const qualityScores = [];
  const promptLengths = [];
  const shotCounts = {};
  const invocationCounters = Object.fromEntries(MODEL_KINDS.map((kind) => [kind, 0]));
  let localPatchCount = 0;
  let fullRegenerationCount = 0;
  let pathRepairCount = 0;
  let missingRequiredFields = 0;

  fixture.renderedResults.forEach((rawResult, offset) => {
    const contract = fixture.contracts[offset];
    const context = fixture.qualityContext[offset];
    const firstGate = evaluateBatchSegmentQuality(rawResult, {
      ...context,
      segmentIndex: context.episodeIndex,
      contract,
      fullPromptText: rawResult.workflow.fullVideoPrompt,
      coverageMode: "shadow",
    });
    const patchable = selectDeterministicQualityPatchFindings(firstGate.findings, {
      safetyEnabled: true,
    });
    const patched = applyDeterministicQualityPatchWithDiff(rawResult, patchable);
    const finalGate = patched.patchDiffs.length
      ? evaluateBatchSegmentQuality(patched.result, {
          ...context,
          segmentIndex: context.episodeIndex,
          contract,
          fullPromptText: patched.result.workflow.fullVideoPrompt,
          coverageMode: "shadow",
        })
      : firstGate;
    const route = routeBatchSegmentOutcome({
      gate: finalGate,
      hasUsableResult: Array.isArray(patched.result.storyboard) && patched.result.storyboard.length > 0,
      coverageStage: "shadow",
    });
    const report = createSegmentQualityReport({
      batchId: `fixture:${fixture.fixtureId}`,
      segmentIndex: context.episodeIndex,
      title: patched.result.title,
      result: patched.result,
      sourceText: contract.sourceText,
      status: route.action === "accept" ? "cached" : "needs_review",
      scheduleProfile: "PHASE_0_REPLAY",
      qualityGate: finalGate,
      patchDiffs: patched.patchDiffs,
      contractHash: contract.contractHash,
    });

    if (route.action === "accept") acceptedSegmentIndexes.push(context.episodeIndex);
    else needsReviewSegmentIndexes.push(context.episodeIndex);
    if (route.action === "regenerate_segment") {
      fullRegenerationCount += 1;
      invocationCounters.single_generation += 1;
    }
    if (route.action === "request_quality_patch" || route.action === "request_event_patch") {
      pathRepairCount += 1;
      invocationCounters.path_repair += 1;
    }
    if (route.action === "enqueue_judge" || route.action === "enqueue_judge_shadow") {
      invocationCounters.coverage_judge += 1;
    }

    localPatchCount += patched.patchDiffs.length;
    patched.patchDiffs.forEach((diff) => uniquePatchPaths.add(diff.path));
    finalGate.blockingFindings.forEach((finding) => {
      blockingFindingFingerprints.push(
        finding.fingerprint || `${context.episodeIndex}:${finding.code}:${finding.path || "segment"}`,
      );
    });
    missingRequiredFields += finalGate.findings.filter((finding) => finding.code === "missing_required_field").length;
    qualityScores.push(report.qualityScore);
    promptLengths.push(patched.result.workflow.fullVideoPrompt.replace(/\s+/g, "").length);
    const shotCount = String(patched.result.storyboard.length);
    shotCounts[shotCount] = (shotCounts[shotCount] || 0) + 1;
  });

  return {
    acceptedSegmentIndexes,
    needsReviewSegmentIndexes,
    blockingFindingFingerprints: blockingFindingFingerprints.sort(),
    uniquePatchPaths: [...uniquePatchPaths].sort(),
    invocationCounters,
    localPatchCount,
    fullRegenerationCount,
    pathRepairCount,
    missingRequiredFields,
    qualityScores,
    promptLengths,
    shotCounts,
    canonicalPromptHashes: fixture.renderedResults.map((result) => result.workflow.canonicalHash),
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
    assert.equal(result.storyboard.length, 4, `segment ${index + 1} should keep four shots`);
    assert.ok(
      result.workflow.fullVideoPrompt.replace(/\s+/g, "").length > 1400,
      `segment ${index + 1} should keep a prompt above 1400 characters`,
    );
  });
  const nearLimit = compileSegmentContractRenderBlock(fixture.contracts.at(-1));
  assert.ok(nearLimit.byteLength >= 2_400 && nearLimit.byteLength <= 3_072);
}

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
    assert.deepEqual(replay.invocationCounters, Object.fromEntries(MODEL_KINDS.map((kind) => [kind, 0])));
    assert.equal(replay.fullRegenerationCount, 0);
    assert.equal(replay.pathRepairCount, 0);
  }
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
  const outputPath = path.join(root, "analysis", "report.json");
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
    await writeJson(path.join(cacheRoot, "batch-fixture.json"), {
      schemaVersion: 2,
      batchId: "batch-fixture",
      durableBatchId: "batch-fixture",
      sourceHash: "synthetic-source",
      contractHash: "synthetic-contract",
      resolvedSegmentCount: 2,
      updatedAt: "2026-07-13T00:00:10.000Z",
      segmentStates: [],
      activeJobIds: ["job-complete"],
      qualityReports: [],
      segments: [],
      needsReviewSegments: [],
      invocationEvents: [{ jobId: "job-complete" }],
    });
    await utimes(completeResult, new Date("2026-07-13T00:00:20.000Z"), new Date("2026-07-13T00:00:20.000Z"));
    const mtimesBefore = new Map(await Promise.all(sourceFiles.map(async (file) => [file, (await stat(file)).mtimeMs])));

    const report = await analyzeBatchJobArtifacts({ root, outputPath });
    const serialized = JSON.stringify(report);

    assert.equal(report.statusCounts.completed, 3);
    assert.equal(report.statusCounts.failed, 2);
    assert.equal(report.statusCounts.running, 1);
    assert.equal(report.failures.CODEX_TIMEOUT, 1);
    assert.equal(Object.keys(report.failures).some((key) => key.startsWith("FIRST_LINE_SHA256:")), true);
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.completedBeforeFinalOutput.some((item) => item.jobId === "job-complete"), true);
    assert.equal(report.orphanCompletedResults.some((item) => item.jobId === "job-orphan"), true);
    assert.ok(report.timingsByTaskClass.render_pack.queueWaitMs.unknown >= 1);
    assert.doesNotMatch(serialized, /PRIVATE_(?:ERROR|ORPHAN_)?PROMPT_MARKER/);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).schemaVersion, 1);
    for (const [file, before] of mtimesBefore) assert.equal((await stat(file)).mtimeMs, before);

    assert.throws(
      () => validateArtifactRoot(path.parse(root).root, { allowExternalRead: false }),
      /outside E:\\localdirector/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
