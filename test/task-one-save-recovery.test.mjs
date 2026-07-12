import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { createResumableBatchSaveController } = require("../lib/batch-segment-progress.ts");
const { buildSegmentBatchRecoveryKeys } = require("../lib/segment-batch-cache.ts");
const {
  SEGMENT_BATCH_RECOVERY_REGISTRY_KEY,
  parseSegmentBatchRecoveryRegistry,
  removeSegmentBatchRecoveryPointer,
  upsertSegmentBatchRecoveryPointer,
} = require("../lib/segment-batch-cache-identity.ts");

test("active recovery registry survives refresh without requiring the source script", () => {
  const pointer = {
    schemaVersion: 1,
    durableBatchId: "batch-refresh-20",
    recoveryKey: "localdirector:segment-batch-recovery:source-specific",
    sourceHash: "source-hash-20",
    projectId: null,
    updatedAt: "2026-07-12T08:00:00.000Z",
  };

  const stored = JSON.stringify(upsertSegmentBatchRecoveryPointer([], pointer));
  const restored = parseSegmentBatchRecoveryRegistry(stored);

  assert.equal(SEGMENT_BATCH_RECOVERY_REGISTRY_KEY, "localdirector:segment-batch-recovery-registry:v1");
  assert.deepEqual(restored, [pointer]);
});

test("recovery registry deduplicates batches, orders newest first, and caps at ten", () => {
  let registry = [];
  for (let index = 0; index < 12; index += 1) {
    registry = upsertSegmentBatchRecoveryPointer(registry, {
      schemaVersion: 1,
      durableBatchId: `batch-${index}`,
      recoveryKey: `localdirector:segment-batch-recovery:key-${index}`,
      sourceHash: `source-${index}`,
      projectId: null,
      updatedAt: new Date(Date.UTC(2026, 6, 12, 8, index)).toISOString(),
    });
  }
  registry = upsertSegmentBatchRecoveryPointer(registry, {
    ...registry[5],
    updatedAt: "2026-07-12T10:00:00.000Z",
  });

  assert.equal(registry.length, 10);
  assert.equal(registry[0].updatedAt, "2026-07-12T10:00:00.000Z");
  assert.equal(new Set(registry.map((item) => item.durableBatchId)).size, 10);
});

test("terminal cleanup removes only the completed recovery pointer", () => {
  const registry = ["a", "b"].map((durableBatchId) => ({
    schemaVersion: 1,
    durableBatchId,
    recoveryKey: `localdirector:segment-batch-recovery:${durableBatchId}`,
    sourceHash: `source-${durableBatchId}`,
    projectId: null,
    updatedAt: "2026-07-12T08:00:00.000Z",
  }));

  assert.deepEqual(
    removeSegmentBatchRecoveryPointer(registry, "a").map((item) => item.durableBatchId),
    ["b"],
  );
});

test("recovery lookup keeps a project-specific key and a safe new-project fallback", () => {
  const input = {
    projectId: "project-1",
    sourceHash: "source-hash",
    mode: "fixed",
    requestedCount: 20,
    duration: "15s",
  };
  const keys = buildSegmentBatchRecoveryKeys(input);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(buildSegmentBatchRecoveryKeys({ ...input, projectId: null }), [keys[1]]);
});

test("retryable save failure uses 1/3/8 second schedule and never poisons resume", async () => {
  const attempts = new Map();
  const delays = [];
  let serviceHealthy = false;
  const controller = createResumableBatchSaveController({
    durableBatchId: "batch-a",
    segmentCount: 3,
    sleep: async (ms) => delays.push(ms),
    saveSegment: async ({ segmentIndex, idempotencyKey }) => {
      attempts.set(segmentIndex, (attempts.get(segmentIndex) || 0) + 1);
      assert.equal(idempotencyKey, `batch-a:${segmentIndex}`);
      if (segmentIndex === 1 && !serviceHealthy) {
        return { saved: false, retryable: true, errorCode: "PROJECT_API_UNAVAILABLE", message: "down", requestId: "r" };
      }
      return { saved: true, projectId: "p", versionId: `v${segmentIndex}`, versionNumber: segmentIndex, idempotentReplay: false, requestId: "r" };
    },
  });

  controller.cache(1, { title: "one" });
  controller.cache(2, { title: "two" });
  controller.cache(3, { title: "three" });
  await controller.drain();
  assert.deepEqual(delays, [1000, 3000, 8000]);
  assert.equal(controller.snapshot().segments[0].status, "save_failed");
  assert.equal(controller.snapshot().segments[1].status, "cached");

  serviceHealthy = true;
  await controller.resume();
  assert.deepEqual(controller.snapshot().segments.map((item) => item.status), ["saved", "saved", "saved"]);
});

test("non-retryable failure makes one attempt and leaves later segments cached", async () => {
  let calls = 0;
  const controller = createResumableBatchSaveController({
    durableBatchId: "batch-b",
    segmentCount: 2,
    sleep: async () => assert.fail("non-retryable failures must not sleep"),
    saveSegment: async ({ segmentIndex }) => {
      calls += 1;
      if (segmentIndex === 1) return { saved: false, retryable: false, errorCode: "PROJECT_VALIDATION_FAILED", message: "bad", requestId: "r" };
      return { saved: true, projectId: "p", versionId: "v", versionNumber: 2, idempotentReplay: false, requestId: "r" };
    },
  });
  controller.cache(1, {});
  controller.cache(2, {});
  await controller.drain();
  assert.equal(calls, 1);
  assert.deepEqual(controller.snapshot().segments.map((item) => item.status), ["save_failed", "cached"]);
});

test("new segment arrivals cannot reset exhausted save retry budgets", async () => {
  const attempts = new Map();
  const failingSegments = new Set([1, 10, 20]);
  const controller = createResumableBatchSaveController({
    durableBatchId: "batch-budget",
    segmentCount: 20,
    sleep: async () => {},
    saveSegment: async ({ segmentIndex }) => {
      attempts.set(segmentIndex, (attempts.get(segmentIndex) || 0) + 1);
      if (failingSegments.has(segmentIndex)) {
        return { saved: false, retryable: true, errorCode: "PROJECT_API_UNAVAILABLE", message: "down" };
      }
      return { saved: true, projectId: "p", versionId: `v${segmentIndex}`, versionNumber: segmentIndex };
    },
  });

  controller.cache(1, { revision: 1 });
  await controller.drain();
  assert.equal(attempts.get(1), 4);
  assert.equal(controller.snapshot().segments[0].status, "save_failed");

  controller.cache(1, { revision: 2 });
  for (let index = 2; index <= 20; index += 1) controller.cache(index, { revision: 1 });
  await controller.drain();

  assert.equal(attempts.get(1), 4, "cache updates must not grant a new retry round");
  assert.equal(controller.snapshot().segments[0].status, "save_failed");
  assert.equal(attempts.has(10), false, "ordered saves remain blocked until explicit resume");
  assert.equal(attempts.has(20), false, "later arrivals do not bypass the failed segment");

  failingSegments.delete(1);
  await controller.resume();
  assert.equal(attempts.get(10), 4);
  controller.cache(10, { revision: 2 });
  await controller.drain();
  assert.equal(attempts.get(10), 4, "segment 10 keeps its exhausted budget until explicit resume");

  failingSegments.delete(10);
  await controller.resume();
  assert.equal(attempts.get(20), 4);
  controller.cache(20, { revision: 2 });
  await controller.drain();
  assert.equal(attempts.get(20), 4, "segment 20 keeps its exhausted budget until explicit resume");
});

