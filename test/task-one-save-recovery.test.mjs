import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { createResumableBatchSaveController } = require("../lib/batch-segment-progress.ts");

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

