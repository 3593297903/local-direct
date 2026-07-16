import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createInitialSegmentState,
  reduceSegmentState,
  deriveBatchPhaseFromSegmentStates,
  progressStatusFromSegmentState,
} = require("../lib/batch-segment-progress.ts");
const {
  createBatchInvocationLedger,
} = require("../lib/batch-repair-scheduler.ts");
const {
  migrateSegmentBatchCacheDocument,
  readSegmentBatchCache,
  writeSegmentBatchCache,
  buildStableBatchContractHash,
  buildSegmentBatchRecoveryKey,
} = require("../lib/segment-batch-cache.ts");

test("illegal SAVE_SUCCEEDED and unrelated REPAIR_COMPLETED events are ignored", () => {
  const initial = createInitialSegmentState(1, { updatedAt: 1 });
  const impossibleSave = reduceSegmentState(initial, {
    type: "SAVE_SUCCEEDED",
    baseRevision: 0,
    review: false,
    at: 2,
  });
  assert.deepEqual(impossibleSave, initial);

  const unrelatedRepair = reduceSegmentState(initial, {
    type: "REPAIR_COMPLETED",
    baseRevision: 0,
    jobId: "unrelated-job",
    resultHash: "result-new",
    at: 3,
  });
  assert.deepEqual(unrelatedRepair, initial);
});

test("contract preflight states are orthogonal and contract invalid cannot enter repair", () => {
  let ready = createInitialSegmentState(1, { contractHash: "contract-ready", updatedAt: 1 });
  ready = reduceSegmentState(ready, {
    type: "CONTRACT_PREFLIGHT_STARTED",
    baseRevision: 0,
    at: 2,
  });
  assert.equal(ready.generationStatus, "preparing_input");
  assert.equal(ready.qualityStatus, "unknown");
  assert.equal(progressStatusFromSegmentState(ready), "validating");

  ready = reduceSegmentState(ready, {
    type: "CONTRACT_PREFLIGHT_READY",
    baseRevision: 1,
    at: 3,
  });
  assert.equal(ready.generationStatus, "pending");
  assert.equal(ready.lastErrorCode, undefined);

  let invalid = createInitialSegmentState(2, { contractHash: "contract-invalid", updatedAt: 1 });
  invalid = reduceSegmentState(invalid, {
    type: "CONTRACT_PREFLIGHT_STARTED",
    baseRevision: 0,
    at: 2,
  });
  invalid = reduceSegmentState(invalid, {
    type: "CONTRACT_PREFLIGHT_INVALID",
    baseRevision: 1,
    errorCode: "CONTRACT_BUDGET_EXCEEDED",
    message: "Contract input requires review",
    at: 3,
  });
  assert.equal(invalid.generationStatus, "contract_invalid");
  assert.equal(invalid.qualityStatus, "unknown");
  assert.equal(invalid.saveStatus, "not_ready");
  assert.equal(invalid.resultHash, undefined);
  assert.equal(invalid.lastErrorCode, "CONTRACT_BUDGET_EXCEEDED");
  assert.equal(progressStatusFromSegmentState(invalid), "failed");

  const repairAttempt = reduceSegmentState(invalid, {
    type: "REPAIR_QUEUED",
    baseRevision: invalid.revision,
    fingerprint: "must-not-run",
    at: 4,
  });
  assert.deepEqual(repairAttempt, invalid);
});

test("authoritative contract rejection invalidates only B and requeues valid render neighbors", () => {
  const beginRendering = (index) => reduceSegmentState(
    createInitialSegmentState(index, { contractHash: `contract-${index}`, updatedAt: 1 }),
    {
      type: "RENDER_OPERATION_CREATED",
      operationToken: "operation-original",
      expectedSourceHash: "source-original",
      expectedContractHash: `contract-${index}`,
      at: 2,
    },
  );
  const [a, b, c] = [1, 2, 3].map(beginRendering);

  const requeue = (state) => reduceSegmentState(state, {
    type: "RENDER_OPERATION_REQUEUED",
    operationToken: "operation-original",
    at: 3,
  });
  const invalid = reduceSegmentState(b, {
    type: "CONTRACT_PREFLIGHT_INVALID",
    errorCode: "CONTRACT_HASH_INVALID",
    message: "authoritative rejection",
    at: 3,
  });

  for (const state of [requeue(a), requeue(c)]) {
    assert.equal(state.generationStatus, "pending");
    assert.equal(state.renderOperationToken, undefined);
    assert.equal(state.activeRenderPackJobId, undefined);
    assert.equal(state.expectedSourceHash, undefined);
    assert.equal(state.expectedContractHash, undefined);
    assert.equal(progressStatusFromSegmentState(state), "pending");
  }
  assert.equal(invalid.generationStatus, "contract_invalid");
  assert.equal(progressStatusFromSegmentState(invalid), "failed");
});

test("one contract-invalid segment does not stop an active valid neighbor", () => {
  let invalid = createInitialSegmentState(1);
  invalid = reduceSegmentState(invalid, { type: "CONTRACT_PREFLIGHT_STARTED", baseRevision: 0, at: 1 });
  invalid = reduceSegmentState(invalid, {
    type: "CONTRACT_PREFLIGHT_INVALID",
    baseRevision: 1,
    errorCode: "CONTRACT_SCHEMA_INVALID",
    at: 2,
  });

  let valid = createInitialSegmentState(2);
  valid = reduceSegmentState(valid, { type: "CONTRACT_PREFLIGHT_STARTED", baseRevision: 0, at: 1 });
  valid = reduceSegmentState(valid, { type: "CONTRACT_PREFLIGHT_READY", baseRevision: 1, at: 2 });
  valid = reduceSegmentState(valid, { type: "RENDER_STARTED", baseRevision: 2, at: 3 });
  assert.equal(deriveBatchPhaseFromSegmentStates([invalid, valid]), "rendering");

  valid = reduceSegmentState(valid, {
    type: "RENDER_SUCCEEDED",
    baseRevision: 3,
    resultHash: "valid-result",
    at: 4,
  });
  valid = reduceSegmentState(valid, { type: "QUALITY_PASSED", baseRevision: 4, at: 5 });
  valid = reduceSegmentState(valid, { type: "CACHE_READY", baseRevision: 5, at: 6 });
  assert.equal(deriveBatchPhaseFromSegmentStates([invalid, valid]), "failed");
});

test("invocation ledger deduplicates durable render creates and retains local preflight metrics", () => {
  const ledger = createBatchInvocationLedger();
  ledger.record("renderPackCalls", { fingerprint: "render:operation-1:job-1" });
  ledger.record("renderPackCalls", { fingerprint: "render:operation-1:job-1" });
  ledger.record("contractPreflightAttempts", { count: 3, fingerprint: "preflight:batch-1:attempts" });
  ledger.record("contractPreflightCompacted", { count: 1, fingerprint: "preflight:batch-1:compacted" });
  ledger.record("contractPreflightInvalid", { count: 1, fingerprint: "preflight:batch-1:invalid" });

  const summary = ledger.summary();
  assert.equal(summary.renderPackCalls, 1);
  assert.equal(summary.contractPreflightAttempts, 3);
  assert.equal(summary.contractPreflightCompacted, 1);
  assert.equal(summary.contractPreflightIsolated, 0);
  assert.equal(summary.contractPreflightInvalid, 1);
});

test("orthogonal reducer preserves quality while save fails and resumes", () => {
  let state = createInitialSegmentState(1, { contractHash: "contract-a" });
  state = reduceSegmentState(state, { type: "RENDER_STARTED", baseRevision: 0, at: 1 });
  state = reduceSegmentState(state, { type: "RENDER_SUCCEEDED", baseRevision: 1, resultHash: "result-a", at: 2 });
  state = reduceSegmentState(state, { type: "QUALITY_PASSED", baseRevision: 2, at: 3 });
  state = reduceSegmentState(state, { type: "CACHE_READY", baseRevision: 3, at: 4 });
  state = reduceSegmentState(state, { type: "SAVE_STARTED", baseRevision: 4, at: 5 });
  state = reduceSegmentState(state, { type: "SAVE_FAILED", baseRevision: 5, errorCode: "PROJECT_API_UNAVAILABLE", at: 6 });

  assert.equal(state.qualityStatus, "passed");
  assert.equal(state.saveStatus, "save_failed");
  assert.equal(state.generationStatus, "settled");

  state = reduceSegmentState(state, { type: "SAVE_RESUMED", baseRevision: 6, at: 7 });
  assert.equal(state.saveStatus, "cached");
});

test("stale events are ignored by revision", () => {
  const initial = createInitialSegmentState(2);
  const running = reduceSegmentState(initial, { type: "RENDER_STARTED", baseRevision: 0, at: 10 });
  const stale = reduceSegmentState(running, { type: "QUALITY_BLOCKED", baseRevision: 0, at: 11 });
  assert.deepEqual(stale, running);
});

test("repair timeout detaches without failing or creating a second job", () => {
  let state = createInitialSegmentState(3, { contractHash: "c" });
  state = reduceSegmentState(state, { type: "REPAIR_QUEUED", baseRevision: 0, jobId: "job-1", fingerprint: "fp-1", at: 1 });
  state = reduceSegmentState(state, { type: "REPAIR_STARTED", baseRevision: 1, jobId: "job-1", at: 2 });
  state = reduceSegmentState(state, { type: "REPAIR_DETACHED", baseRevision: 2, jobId: "job-1", at: 3 });
  assert.equal(state.generationStatus, "repair_detached");
  assert.equal(state.activeRepairJobId, "job-1");
  assert.equal(progressStatusFromSegmentState(state), "patching");
});

test("batch phase derives from records instead of scattered counters", () => {
  const saved = reduceSegmentState(
    reduceSegmentState(
      reduceSegmentState(
        reduceSegmentState(createInitialSegmentState(1), { type: "RENDER_SUCCEEDED", baseRevision: 0, resultHash: "a", at: 1 }),
        { type: "QUALITY_PASSED", baseRevision: 1, at: 2 },
      ),
      { type: "CACHE_READY", baseRevision: 2, at: 3 },
    ),
    { type: "SAVE_SUCCEEDED", baseRevision: 3, review: false, at: 4 },
  );
  const review = reduceSegmentState(
    reduceSegmentState(
      reduceSegmentState(createInitialSegmentState(2), { type: "RENDER_SUCCEEDED", baseRevision: 0, resultHash: "b", at: 1 }),
      { type: "QUALITY_NEEDS_REVIEW", baseRevision: 1, at: 2 },
    ),
    { type: "SAVE_SUCCEEDED", baseRevision: 2, review: true, at: 3 },
  );
  assert.equal(deriveBatchPhaseFromSegmentStates([saved, review]), "needs_review");
});

test("cache v1 migrates to complete v2 state without truncating segment results", () => {
  const promptText = "完整提示词".repeat(1000);
  const migrated = migrateSegmentBatchCacheDocument({
    schemaVersion: 1,
    batchId: "batch-migrate",
    sourceHash: "src",
    contractHash: "contract",
    resolvedSegmentCount: 2,
    updatedAt: new Date(0).toISOString(),
    qualityReports: [],
    needsReviewSegments: [],
    segmentStates: [{ index: 1, status: "saved", message: "done" }],
    segments: [{ episodeIndex: 1, status: "saved", promptText, result: { title: "one" } }],
  }, 123);

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.durableBatchId, "batch-migrate");
  assert.equal(migrated.segmentStates[0].saveStatus, "saved");
  assert.equal(migrated.segments[0].promptText, promptText);
});

test("cache v2 rejects a lower revision and preserves the newer document", async () => {
  const rootDir = path.join(os.tmpdir(), `task-one-cache-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const state = createInitialSegmentState(1, { updatedAt: 1 });
  const base = {
    schemaVersion: 2,
    revision: 2,
    batchId: "task-one-v2",
    durableBatchId: "task-one-v2",
    sourceHash: "src",
    contractHash: "contract",
    resolvedSegmentCount: 1,
    updatedAt: new Date().toISOString(),
    segmentStates: [state],
    activeJobIds: [],
    qualityReports: [],
    needsReviewSegments: [],
    segments: [{ episodeIndex: 1, promptText: "完整结果", result: { title: "one" } }],
  };
  try {
    await writeSegmentBatchCache(base, { rootDir });
    await assert.rejects(
      () => writeSegmentBatchCache({ ...base, revision: 1 }, { rootDir }),
      /revision is stale/i,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("cache v2 preserves the invocation ledger without adding calls", async () => {
  const rootDir = path.join(os.tmpdir(), `task-one-cache-ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const document = {
    schemaVersion: 2,
    revision: 1,
    batchId: "task-one-ledger",
    durableBatchId: "task-one-ledger",
    sourceHash: "src",
    contractHash: "contract",
    resolvedSegmentCount: 1,
    updatedAt: new Date().toISOString(),
    segmentStates: [createInitialSegmentState(1, { updatedAt: 1 })],
    activeJobIds: [],
    qualityReports: [],
    needsReviewSegments: [],
    segments: [{ episodeIndex: 1, promptText: "完整结果", result: { title: "one" } }],
    invocationEvents: [
      { name: "renderPackCalls", at: 10, count: 2 },
      { name: "judgeCalls", at: 20, count: 1, segmentIndex: 1 },
    ],
  };
  try {
    await writeSegmentBatchCache(document, { rootDir });
    const restored = await readSegmentBatchCache(document.batchId, { rootDir });
    assert.deepEqual(restored.invocationEvents, document.invocationEvents);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("cache v2 preserves contract preflight state error and frozen feature flag", async () => {
  const rootDir = path.join(os.tmpdir(), `task-one-contract-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let invalid = createInitialSegmentState(1, { contractHash: "contract-invalid", updatedAt: 1 });
  invalid = reduceSegmentState(invalid, {
    type: "CONTRACT_PREFLIGHT_STARTED",
    baseRevision: invalid.revision,
    at: 2,
  });
  invalid = reduceSegmentState(invalid, {
    type: "CONTRACT_PREFLIGHT_INVALID",
    baseRevision: invalid.revision,
    errorCode: "CONTRACT_PROMPT_BUDGET_EXCEEDED",
    message: "Contract input requires review",
    at: 3,
  });
  const document = {
    schemaVersion: 2,
    revision: 1,
    batchId: "task-one-contract-cache",
    durableBatchId: "task-one-contract-cache",
    sourceHash: "src",
    contractHash: "contract",
    resolvedSegmentCount: 1,
    updatedAt: new Date().toISOString(),
    featureFlags: {
      contractV2: true,
      contractPreflightV2: false,
      coverageSidecar: true,
      coverageStage: "shadow",
      emergencyStop: false,
      capturedAt: new Date(0).toISOString(),
    },
    segmentStates: [invalid],
    activeJobIds: [],
    qualityReports: [],
    needsReviewSegments: [],
    segments: [],
  };
  try {
    await writeSegmentBatchCache(document, { rootDir });
    const restored = await readSegmentBatchCache(document.batchId, { rootDir });
    assert.equal(restored.segmentStates[0].generationStatus, "contract_invalid");
    assert.equal(restored.segmentStates[0].lastErrorCode, "CONTRACT_PROMPT_BUDGET_EXCEEDED");
    assert.equal(restored.featureFlags.contractPreflightV2, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stable batch identity excludes transient season job ids", () => {
  const contracts = [
    { segmentIndex: 2, contractHash: "contract-b" },
    { segmentIndex: 1, contractHash: "contract-a" },
  ];
  assert.equal(
    buildStableBatchContractHash(contracts),
    buildStableBatchContractHash([...contracts].reverse()),
  );
  const recoveryIdentity = {
    projectId: null,
    sourceHash: "source",
    mode: "fixed",
    requestedCount: 20,
    duration: "auto",
  };
  const legacyDigest = createHash("sha256").update(JSON.stringify(recoveryIdentity)).digest("hex");
  assert.equal(
    buildSegmentBatchRecoveryKey(recoveryIdentity),
    `localdirector:segment-batch-recovery:${legacyDigest}`,
  );
});

test("a delayed repair completion cannot overwrite a newer repair lifecycle", () => {
  let state = createInitialSegmentState(1);
  state = reduceSegmentState(state, { type: "RENDER_STARTED" });
  state = reduceSegmentState(state, { type: "RENDER_SUCCEEDED", resultHash: "original" });
  state = reduceSegmentState(state, { type: "QUALITY_BLOCKED", message: "missing" });
  state = reduceSegmentState(state, { type: "REPAIR_QUEUED", fingerprint: "first" });
  state = reduceSegmentState(state, { type: "REPAIR_STARTED", jobId: "job-old" });
  const oldRevision = state.revision;

  state = reduceSegmentState(state, { type: "REPAIR_FAILED", jobId: "job-old" });
  state = reduceSegmentState(state, { type: "REPAIR_QUEUED", fingerprint: "second" });
  state = reduceSegmentState(state, { type: "REPAIR_STARTED", jobId: "job-new" });

  const afterLateCompletion = reduceSegmentState(state, {
    type: "REPAIR_COMPLETED",
    jobId: "job-old",
    resultHash: "stale-result",
    baseRevision: oldRevision,
  });

  assert.deepEqual(afterLateCompletion, state);
  assert.equal(afterLateCompletion.activeRepairJobId, "job-new");
  assert.notEqual(afterLateCompletion.resultHash, "stale-result");
});

test("save success remains legal after an unrelated repair message update", () => {
  let state = createInitialSegmentState(1);
  for (const event of [
    { type: "RENDER_STARTED" },
    { type: "RENDER_SUCCEEDED", resultHash: "result-v1" },
    { type: "QUALITY_NEEDS_REVIEW", message: "repair detached" },
    { type: "REPAIR_QUEUED", fingerprint: "repair-fp" },
    { type: "REPAIR_STARTED", jobId: "repair-job" },
    { type: "REPAIR_DETACHED", jobId: "repair-job" },
    { type: "CACHE_READY" },
    { type: "SAVE_STARTED" },
    { type: "MESSAGE_UPDATED", message: "后台修复状态读取失败" },
    { type: "SAVE_SUCCEEDED", review: true },
  ]) {
    state = reduceSegmentState(state, event);
  }

  assert.equal(state.saveStatus, "review_saved");
  assert.equal(state.generationStatus, "repair_detached");
  assert.equal(state.activeRepairJobId, "repair-job");
});

test("save failure preserves a detached repair lifecycle", () => {
  let state = createInitialSegmentState(1);
  for (const event of [
    { type: "RENDER_STARTED" },
    { type: "RENDER_SUCCEEDED", resultHash: "result-v1" },
    { type: "QUALITY_NEEDS_REVIEW" },
    { type: "REPAIR_QUEUED", fingerprint: "repair-fp" },
    { type: "REPAIR_STARTED", jobId: "repair-job" },
    { type: "REPAIR_DETACHED", jobId: "repair-job" },
    { type: "CACHE_READY" },
    { type: "SAVE_STARTED" },
    { type: "SAVE_FAILED", errorCode: "PROJECT_API_UNAVAILABLE" },
  ]) {
    state = reduceSegmentState(state, event);
  }

  assert.equal(state.saveStatus, "save_failed");
  assert.equal(state.generationStatus, "repair_detached");
  assert.equal(state.activeRepairJobId, "repair-job");
});

test("recaching a repaired result cannot erase an exhausted save failure", () => {
  let state = createInitialSegmentState(1);
  for (const event of [
    { type: "RENDER_STARTED" },
    { type: "RENDER_SUCCEEDED", resultHash: "result-v1" },
    { type: "QUALITY_PASSED" },
    { type: "CACHE_READY" },
    { type: "SAVE_STARTED" },
    { type: "SAVE_FAILED", errorCode: "PROJECT_API_UNAVAILABLE" },
    { type: "CACHE_READY" },
  ]) {
    state = reduceSegmentState(state, event);
  }

  assert.equal(state.saveStatus, "save_failed");
  state = reduceSegmentState(state, { type: "SAVE_RESUMED" });
  assert.equal(state.saveStatus, "cached");
});
