import assert from "node:assert/strict";
import test from "node:test";

import {
  createPhase2LifecycleReport,
  runPhase2RenderRecoveryHarness,
} from "../scripts/benchmark-phase-2-render-lifecycle.mjs";

const passingPhysicalCoordinator = Object.freeze({
  callers: 100,
  elapsedMs: 12_000,
  maxActive: 4,
  maxNonOriginalWithOriginalDemand: 1,
  starvationCount: 0,
  lockTimeoutCount: 0,
  remainingWaiters: 0,
  remainingLeases: 0,
});

test("23 minute queue plus 8 minute execution uses production recovery helpers and one Render job", async () => {
  const scenario = await runPhase2RenderRecoveryHarness();
  const report = createPhase2LifecycleReport({ scenario, physicalCoordinator: passingPhysicalCoordinator });
  assert.equal(report.status, "accepted");
  assert.equal(scenario.renderJobsCreated, 1);
  assert.equal(scenario.durableOperationTokens.length, 1);
  assert.equal(scenario.foregroundDetached, true);
  assert.equal(scenario.observerStartsByJob["render-job-main"], 1);
  assert.equal(scenario.mainScenarioMergedSegments, 5);
  assert.equal(scenario.duplicateMergeCount, 0);
  assert.equal(scenario.singleGenerationCalls, 0);
  assert.equal(scenario.modelCalls, 0);
  assert.equal(scenario.judgeCalls, 0);
  assert.equal(scenario.repairCalls, 0);
  assert.equal(scenario.fallbackCalls, 0);
  for (const helper of [
    "observeRenderPackJob",
    "startConcurrentRenderRecoveryObservers",
    "reconcileDetachedRenderPack",
    "prepareRenderPackReconciliation",
    "applyPreparedRenderPackReconciliation",
  ]) {
    assert.ok(report.productionHelpersUsed.includes(helper), helper);
  }
});

test("refresh observers avoid head-of-line blocking and remount merges the same durable operation once", async () => {
  const scenario = await runPhase2RenderRecoveryHarness();
  assert.equal(scenario.refreshNoHeadOfLineBlocking, true);
  assert.equal(scenario.statusPollsByJob["refresh-job-2"], 1);
  assert.equal(scenario.statusPollsByJob["refresh-job-3"], 2);
  assert.equal(scenario.remountMergeCount, 1);
  assert.equal(scenario.abortedObservers, 2);
  assert.equal(scenario.remainingTimers, 0);
  assert.equal(scenario.remainingObserverEntries, 0);
});

test("malformed reconciliation context is rejected before mutation", async () => {
  const scenario = await runPhase2RenderRecoveryHarness();
  assert.equal(scenario.malformedContextRejected, true);
  assert.equal(scenario.malformedContextMutationCount, 0);
});

test("lifecycle report rejects duplicate create missing merge and any model or repair call", async () => {
  for (const faults of [
    { duplicateCreate: true },
    { omitMergeSegment: 3 },
    { modelCalls: 1 },
    { repairCalls: 1 },
    { judgeCalls: 1 },
    { fallbackCalls: 1 },
  ]) {
    const scenario = await runPhase2RenderRecoveryHarness({ faults });
    const report = createPhase2LifecycleReport({ scenario, physicalCoordinator: passingPhysicalCoordinator });
    assert.equal(report.status, "rejected", JSON.stringify(faults));
    assert.ok(report.failedChecks.length > 0);
  }
});
