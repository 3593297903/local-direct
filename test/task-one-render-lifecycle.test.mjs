import assert from "node:assert/strict";
import test from "node:test";

import {
  runDeterministicRenderLifecycleScenario,
} from "../scripts/benchmark-phase-2-render-lifecycle.mjs";

test("23 minute queue plus 8 minute execution creates one job and no timeout fallback", () => {
  const result = runDeterministicRenderLifecycleScenario({
    segmentIndexes: [1, 2, 3, 4, 5],
    queueWaitMs: 23 * 60_000,
    executionMs: 8 * 60_000,
    foregroundAttentionMs: 12 * 60_000,
    pollIntervalMs: 30_000,
  });
  assert.equal(result.renderJobsCreated, 1);
  assert.equal(result.singleGenerationCalls, 0);
  assert.equal(result.lateMergeCount, 5);
  assert.equal(result.duplicateLateMerges, 0);
  assert.equal(result.qualityGateExecutions, 5);
  assert.equal(result.observerCount, 1);
  assert.equal(result.finalStatus, "merged");
});

test("polling cardinality follows jobs rather than segment count", () => {
  const one = runDeterministicRenderLifecycleScenario({ segmentIndexes: [1], queueWaitMs: 60_000, executionMs: 60_000 });
  const five = runDeterministicRenderLifecycleScenario({ segmentIndexes: [1, 2, 3, 4, 5], queueWaitMs: 60_000, executionMs: 60_000 });
  assert.equal(one.statusPolls, five.statusPolls);
  assert.equal(one.observerCount, five.observerCount);
});

test("stale result is ignored without model repair or fallback", () => {
  const result = runDeterministicRenderLifecycleScenario({
    segmentIndexes: [1, 2, 3],
    queueWaitMs: 60_000,
    executionMs: 60_000,
    staleAtCompletion: true,
  });
  assert.equal(result.lateMergeCount, 0);
  assert.equal(result.staleIgnoreCount, 3);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.repairCalls, 0);
  assert.equal(result.singleGenerationCalls, 0);
});
