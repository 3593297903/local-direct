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

test("refresh recovery uses session ownership and offers save-only continuation before season creation", () => {
  assert.match(source, /sessionStorage/);
  assert.match(source, /继续保存已缓存段/);
  assert.match(source, /resumeCachedBatchSavesOnly|resumeCachedSavesOnly/);
  assert.doesNotMatch(source, /batchId:\s*seasonPackJob\.id[\s\S]{0,180}contractHash/);
});

test("save-only recovery cannot invoke generation, judge, or repair APIs", () => {
  const start = source.indexOf("async function resumeCachedBatchSavesOnly");
  const end = source.indexOf("async function runBatchEpisodeGeneration", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /saveAnalysisProject/);
  assert.doesNotMatch(body, /createSeasonPackCodexJob|createVideoPromptPackCodexJob|createEventCoverageCodexJob|requestBatchSegmentRepairPatchWithContext|requestAnalysis/);
  assert.match(body, /模型调用增量为 0/);
});

test("detached repair watcher performs one status query per observation cycle", () => {
  const start = source.indexOf("async function watchDetachedRepair");
  const end = source.indexOf("async function repairExistingBatchSegment", start);
  const body = source.slice(start, end);
  assert.match(body, /queryBatchSegmentRepairCodexJob/);
  assert.doesNotMatch(body, /pollBatchSegmentRepairCodexJob/);
  assert.match(body, /shouldContinueDetachedRepairObservation/);
  assert.match(body, /detachedAt\s*=\s*Date\.now\(\)/);
  assert.match(source, /watchDetachedRepair\([\s\S]{0,500}restoredState\.updatedAt/);
});

test("task-one rollback flags degrade safely without restoring legacy full-result repair", () => {
  assert.match(source, /NEXT_PUBLIC_TASK_ONE_SAFETY/);
  assert.match(source, /NEXT_PUBLIC_TASK_ONE_STATE_REDUCER/);
  assert.match(source, /NEXT_PUBLIC_TASK_ONE_CACHE_RECOVERY/);
  assert.match(source, /NEXT_PUBLIC_TASK_ONE_REPAIR_SCHEDULER/);
  assert.doesNotMatch(source, /fallback.*full.*result/i);
});

test("repair state waits for the real Codex job id and completes that same job", () => {
  const schedulerStart = source.indexOf("repairScheduler = createBatchRepairScheduler");
  const schedulerEnd = source.indexOf("function signalRepairScheduler", schedulerStart);
  const schedulerBody = source.slice(schedulerStart, schedulerEnd);
  assert.doesNotMatch(schedulerBody, /onStarted:[\s\S]{0,300}REPAIR_STARTED/);

  const repairStart = source.indexOf("async function repairExistingBatchSegment");
  const repairEnd = source.indexOf("async function renderBatchSegmentWithQualityRepair", repairStart);
  const repairBody = source.slice(repairStart, repairEnd);
  assert.match(repairBody, /onJobCreated:[\s\S]{0,260}REPAIR_STARTED/);
  assert.match(repairBody, /type:\s*"REPAIR_COMPLETED"[\s\S]{0,180}repairRequest\.jobId/);
});

test("new cache indexes restore durableBatchId and keep the legacy batchId fallback", () => {
  assert.match(source, /batchIndex\.durableBatchId[\s\S]{0,180}batchIndex\.batchId/);
});

test("first successful save migrates the recovery index to the persisted project and completion clears it", () => {
  assert.match(source, /batchProjectId\s*=\s*save\.projectId/);
  assert.match(source, /activeRecoveryKey\s*=\s*buildSegmentBatchRecoveryKey/);
  assert.match(source, /batchRecoveryIndexKeys\.add\(activeRecoveryKey\)/);
  assert.match(source, /function clearBatchRecoveryState/);
  assert.match(source, /publishBatchProgress\("completed"[\s\S]{0,220}clearBatchRecoveryState\(\)/);
});

