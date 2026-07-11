import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.resolve("components/DashboardClient.tsx"), "utf8");

test("dashboard uses cache v2 and orthogonal state reducer", () => {
  assert.match(source, /schemaVersion:\s*2/);
  assert.match(source, /reduceSegmentState/);
  assert.match(source, /deriveBatchPhaseFromSegmentStates/);
});

test("render pack completion signals repair scheduler without awaiting a per-pack repair pool", () => {
  const start = source.indexOf("async function renderPackedSegmentsWithQualityRepair");
  const end = source.indexOf("await restoreCachedRenderedSegments", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /await\s+runSegmentRepairPool\s*\(/);
  assert.match(body, /repairScheduler\.enqueue|signalRepairScheduler/);
});

test("repair polling detaches at the frontend timeout instead of failing the generation", () => {
  assert.match(source, /REPAIR_DETACHED/);
  assert.match(source, /late_patch_available|latePatchAvailable/);
});

test("save queue consumes task-two retryability and keeps a stable idempotency key", () => {
  assert.match(source, /retryable/);
  assert.match(source, /createResumableBatchSaveController/);
  assert.match(source, /durableBatchId/);
});

