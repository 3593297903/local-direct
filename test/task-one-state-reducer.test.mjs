import assert from "node:assert/strict";
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
  migrateSegmentBatchCacheDocument,
  writeSegmentBatchCache,
} = require("../lib/segment-batch-cache.ts");

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
