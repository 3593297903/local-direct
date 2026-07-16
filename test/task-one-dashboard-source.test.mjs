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

test("render pack completion delegates routing without awaiting a per-pack repair pool", () => {
  const start = source.indexOf("async function renderPackedSegmentsWithQualityRepair");
  const end = source.indexOf("await restoreCachedRenderedSegments", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /await\s+runSegmentRepairPool\s*\(/);
  assert.match(body, /reconcileAndRouteRenderPackResult/);
});

test("transient render-pack polling failures keep the original job and never fan out into segment regeneration", () => {
  const pollStart = source.indexOf("async function pollVideoPromptPackCodexJob");
  const pollEnd = source.indexOf("async function pollVideoPromptCodexJob", pollStart);
  const pollBody = source.slice(pollStart, pollEnd);
  assert.match(pollBody, /observeRenderPackJob/);
  assert.match(pollBody, /mode:\s*"foreground"/);
  assert.match(pollBody, /RenderPackPollingInfrastructureError/);
  assert.doesNotMatch(pollBody, /queueSegmentRepair|renderBatchSegmentWithQualityRepair/);

  const renderStart = source.indexOf("async function renderPackedSegmentsWithQualityRepair");
  const renderEnd = source.indexOf("await restoreCachedRenderedSegments", renderStart);
  const renderBody = source.slice(renderStart, renderEnd);
  assert.match(renderBody, /isRenderPackPollingInfrastructureError\(error\)/);
  assert.match(renderBody, /throw error/);
});

test("dashboard owns and aborts Render observer registries without mutating durable state", () => {
  assert.match(source, /renderRecoveryObserverRegistryRef/);
  assert.match(source, /renderPackObserverRegistryRef/);
  assert.match(source, /abortAll\(\)/);
  assert.match(source, /NEXT_PUBLIC_BATCH_RENDER_LATE_RECONCILIATION/);
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

test("needs-review results become cache-ready and are not reported complete before review-save succeeds", () => {
  const storeStart = source.indexOf("function storeRenderedEpisode");
  const storeEnd = source.indexOf("async function renderSingleEpisodeWithQualityRepair", storeStart);
  const storeBody = source.slice(storeStart, storeEnd);
  assert.match(storeBody, /renderedEpisodes\[episodeIndex - 1\][\s\S]{0,500}type:\s*"CACHE_READY"/);

  const reviewStart = source.indexOf("if (finalNeedsReviewCount)");
  const reviewEnd = source.indexOf("for (const rendered of renderedEpisodes)", reviewStart);
  const reviewBody = source.slice(reviewStart, reviewEnd);
  assert.match(reviewBody, /unsavedReviewSegmentStates/);
  assert.match(reviewBody, /return/);
  assert.match(reviewBody, /clearBatchRecoveryState\(\)/);
});

test("automatic planning progress never reads episodes before the season result exists", () => {
  const publishStart = source.indexOf("function publishBatchProgress");
  const publishEnd = source.indexOf("function rebuildSegmentProgressFromState", publishStart);
  const publishBody = source.slice(publishStart, publishEnd);
  const firstPlanningCall = source.search(/publishBatchProgress\(\s*["']planning["']/);
  const episodesDeclaration = source.indexOf(
    "const episodes = [...(seasonPackJob.result?.episodes || [])]",
  );

  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  assert.ok(firstPlanningCall >= 0 && episodesDeclaration > firstPlanningCall);
  assert.doesNotMatch(publishBody, /\bepisodes\b/);
  assert.match(publishBody, /resolvedSegmentCount:\s*resolvedSegmentCount\b|\bresolvedSegmentCount,\s*\n/);
});

test("refresh recovery discovers active batches before source-dependent fallback", () => {
  const start = source.indexOf("async function discoverBatchSaveRecovery");
  const end = source.indexOf("function ensureBatchSaveRecoveryDiscovery", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /SEGMENT_BATCH_RECOVERY_REGISTRY_KEY|readBatchRecoveryRegistry/);
  assert.doesNotMatch(body.slice(0, 700), /!script\.trim\(\)/);
  assert.match(body, /pointer\.sourceHash|sourceHash:\s*pointer\.sourceHash/);
});

test("recovery discovery is cache-only and cannot invoke any model API", () => {
  const start = source.indexOf("async function discoverBatchSaveRecovery");
  const end = source.indexOf("function ensureBatchSaveRecoveryDiscovery", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /\/api\/segment-batch-cache\//);
  assert.doesNotMatch(
    body,
    /createSeasonPackCodexJob|createVideoPromptPackCodexJob|createEventCoverageCodexJob|requestBatchSegmentRepairPatchWithContext|requestAnalysisWithContext|requestAnalysis\(/,
  );
});

test("dashboard never stamps an omitted event with the latest revision at dispatch time", () => {
  const start = source.indexOf("function dispatchSegmentStateEvent");
  const end = source.indexOf("function updateSegmentProgress", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /baseRevision:\s*effectiveEvent\.baseRevision\s*\?\?\s*item\.revision/);
});

test("detached repair polling validates persisted repair identity around each query", () => {
  const start = source.indexOf("async function watchDetachedRepair");
  const end = source.indexOf("async function repairExistingBatchSegment", start);
  const body = source.slice(start, end);
  const capture = body.indexOf("captureRepairOperationIdentity");
  const query = body.indexOf("await queryBatchSegmentRepairCodexJob");
  assert.ok(capture >= 0 && query > capture);
  assert.match(body, /queryIdentity\?\.jobId/);
  assert.match(body, /isCurrentRepairOperation/);
  assert.match(body, /dispatchCurrentRepairEvent/);
  assert.doesNotMatch(body, /baseRevision|dispatchGuardedSegmentStateEvent/);
});

test("display progress cannot synthesize domain state transitions", () => {
  const start = source.indexOf("function updateSegmentProgress");
  const end = source.indexOf("publishBatchProgress(", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /RENDER_STARTED|REPAIR_QUEUED|QUALITY_PASSED|QUALITY_BLOCKED|CACHE_READY|SAVE_STARTED|SAVE_SUCCEEDED/);
  assert.match(body, /PROGRESS_UPDATED/);
});

test("safety rollback cannot disable ordinary deterministic quality patches", () => {
  const start = source.indexOf("const firstGate = evaluateBatchSegmentQuality");
  const end = source.indexOf("const finalGate = evaluateBatchSegmentQuality", start);
  const body = source.slice(start, end);
  assert.match(body, /selectDeterministicQualityPatchFindings/);
  assert.match(body, /applyDeterministicQualityPatchWithDiff/);
  assert.doesNotMatch(body, /TASK_ONE_SAFETY_ENABLED\s*\?\s*applyDeterministicQualityPatchWithDiff/);
});

test("clean deterministic results reuse the first quality gate instead of rescanning", () => {
  const start = source.indexOf("function normalizePatchAndEvaluateBatchSegment");
  const end = source.indexOf("function normalizePatchAndValidateBatchSegment", start);
  const body = source.slice(start, end);
  assert.match(body, /patched\.patchDiffs\.length\s*>\s*0/);
  assert.match(body, /hasDeterministicChanges\s*\?\s*evaluateBatchSegmentQuality/);
  assert.match(body, /:\s*firstGate/);
});

test("save completion uses save identity instead of the global segment revision", () => {
  const start = source.indexOf("const batchSaveController = createResumableBatchSaveController");
  const end = source.indexOf("function queueReadySegmentSaves", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /idempotencyKey|resultHash/);
  assert.match(body, /isCurrentSaveOperation|isSaveOperationCurrent/);
  assert.doesNotMatch(body, /dispatchGuardedSegmentStateEvent\(saveOperationGuards/);
});

test("render completion uses an operation token instead of a global revision snapshot", () => {
  const start = source.indexOf("async function renderPackedSegmentsWithQualityRepair");
  const end = source.indexOf("await restoreCachedRenderedSegments", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /beginRenderOperation|createRenderOperation/);
  assert.match(body, /isCurrentRenderOperation|isRenderOperationCurrent/);
  assert.doesNotMatch(body, /Map<number, SegmentStateGuard>/);
});

test("repair completion validates persisted repair identity instead of display revision", () => {
  const start = source.indexOf("async function watchDetachedRepair");
  const end = source.indexOf("async function repairExistingBatchSegment", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /jobId/);
  assert.match(body, /resultHash/);
  assert.doesNotMatch(body, /isSegmentStateGuardCurrent/);
});

test("batch generation awaits registry recovery discovery before season planning", () => {
  const start = source.indexOf("async function runBatchEpisodeGeneration");
  const season = source.indexOf("const seasonPackJob = await", start);
  const body = source.slice(start, season);
  assert.ok(start >= 0 && season > start);
  assert.match(body, /await\s+(?:ensure|discover|resolve)[A-Za-z0-9_]*Batch[A-Za-z0-9_]*Recovery/);
  assert.match(body, /resumeCachedBatchSavesOnly/);
});

test("unavailable recovery infrastructure blocks season planning instead of racing ahead", () => {
  const start = source.indexOf("async function runBatchEpisodeGeneration");
  const season = source.indexOf("const seasonPackJob = await", start);
  const body = source.slice(start, season);
  assert.ok(start >= 0 && season > start);
  assert.match(body, /recoveryDiscovery\.status\s*===\s*["']unavailable["']/);
  assert.match(body, /setError\(recoveryDiscovery\.message\)/);
  assert.match(body, /setGenerationProgress\(recoveryDiscovery\.message\)/);
  assert.match(body, /return;/);
});

test("canonical prompt fields are rebuilt even when no deterministic patch changed a leaf", () => {
  const start = source.indexOf("function normalizePatchAndEvaluateBatchSegment");
  const end = source.indexOf("function normalizePatchAndValidateBatchSegment", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /const patchedResult = canonicalizeBatchSegmentResult\(patched\.result\)/);
  assert.doesNotMatch(body, /hasDeterministicChanges\s*\?\s*canonicalizeBatchSegmentResult/);
});

