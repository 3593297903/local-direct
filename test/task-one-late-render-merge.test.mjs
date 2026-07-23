import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  applyPreparedRenderPackReconciliation,
  prepareRenderPackReconciliation,
  reconcileDetachedRenderPack,
} = require("../lib/batch-render-reconciliation.ts");
const {
  createRenderOperationDraft,
  attachRenderOperationJob,
  terminateRenderOperation,
} = require("../lib/batch-render-operation.ts");

function operation() {
  const draft = createRenderOperationDraft({
    batchId: "batch-late-1",
    operationToken: "render-token-1",
    segmentIndexes: [1, 2],
    contractHashes: { 1: "contract-1", 2: "contract-2" },
    now: "2026-07-16T00:00:00.000Z",
  });
  return attachRenderOperationJob(draft, {
    jobId: "render-job-1",
    sourceHash: "source-1",
    aggregateContractHash: draft.aggregateContractHash,
  });
}

function completedJob(overrides = {}) {
  const op = operation();
  return {
    id: op.jobId,
    protocolVersion: 2,
    status: "completed",
    stage: "completed",
    resultAvailable: true,
    batchId: op.batchId,
    operationToken: op.operationToken,
    sourceHash: op.sourceHash,
    aggregateContractHash: op.aggregateContractHash,
    segmentIndexes: [1, 2],
    contractHashes: { 1: "contract-1", 2: "contract-2" },
    resultHash: "manifest-result-1",
    result: {
      segments: [
        { episodeIndex: 1, resultHash: "result-1", result: { title: "one" } },
        { episodeIndex: 2, resultHash: "result-2", result: { title: "two" } },
      ],
    },
    ...overrides,
  };
}

function currentSegments(overrides = {}) {
  const op = operation();
  return {
    1: { operationToken: op.operationToken, sourceHash: op.sourceHash, contractHash: "contract-1" },
    2: { operationToken: op.operationToken, sourceHash: op.sourceHash, contractHash: "contract-2" },
    ...overrides,
  };
}

test("exact late identity merges every segment exactly once without invoking providers", () => {
  const counters = { model: 0, judge: 0, repair: 0, fallback: 0 };
  const decision = reconcileDetachedRenderPack({
    operation: operation(),
    job: completedJob(),
    manifestValidated: true,
    currentSegments: currentSegments(),
  });
  assert.deepEqual(decision, {
    status: "merged",
    segmentIndexes: [1, 2],
    resultHashes: { 1: "result-1", 2: "result-2" },
  });
  assert.deepEqual(counters, { model: 0, judge: 0, repair: 0, fallback: 0 });
});

test("replaying the same finalized operation performs no second merge", () => {
  const merged = terminateRenderOperation(operation(), {
    state: "merged",
    at: "2026-07-16T00:10:00.000Z",
    finalManifestHash: "manifest-result-1",
    resultHashes: { 1: "result-1", 2: "result-2" },
  });
  const decision = reconcileDetachedRenderPack({
    operation: merged,
    job: completedJob(),
    manifestValidated: true,
    currentSegments: {
      1: { resultHash: "result-1" },
      2: { resultHash: "result-2" },
    },
  });
  assert.deepEqual(decision, {
    status: "replay",
    segmentIndexes: [1, 2],
    resultHashes: { 1: "result-1", 2: "result-2" },
  });
});

test("a newer operation token prevents a stale late result from overwriting it", () => {
  const decision = reconcileDetachedRenderPack({
    operation: operation(),
    job: completedJob(),
    manifestValidated: true,
    currentSegments: currentSegments({
      2: { ...currentSegments()[2], operationToken: "render-token-newer" },
    }),
  });
  assert.equal(decision.status, "ignored");
  assert.equal(decision.reasonCode, "RENDER_RECONCILIATION_STALE_OPERATION");
});

test("changed current source or contract prevents merge", () => {
  for (const changed of [
    { 1: { ...currentSegments()[1], sourceHash: "source-new" } },
    { 1: { ...currentSegments()[1], contractHash: "contract-new" } },
  ]) {
    const decision = reconcileDetachedRenderPack({
      operation: operation(),
      job: completedJob(),
      manifestValidated: true,
      currentSegments: currentSegments(changed),
    });
    assert.equal(decision.status, "ignored");
  }
});

test("missing extra duplicate and out-of-order segment identities are rejected", () => {
  for (const segmentIndexes of [[1], [1, 2, 3], [1, 1], [2, 1]]) {
    const decision = reconcileDetachedRenderPack({
      operation: operation(),
      job: completedJob({ segmentIndexes }),
      manifestValidated: true,
      currentSegments: currentSegments(),
    });
    assert.equal(decision.status, "failed");
    assert.equal(decision.errorCode, "RENDER_RECONCILIATION_SEGMENT_IDENTITY_INVALID");
  }
});

test("a completed result without a valid Phase 1 manifest cannot merge", () => {
  for (const input of [
    { manifestValidated: false, job: completedJob() },
    { manifestValidated: true, job: completedJob({ resultAvailable: false, result: undefined }) },
  ]) {
    const decision = reconcileDetachedRenderPack({
      operation: operation(),
      currentSegments: currentSegments(),
      ...input,
    });
    assert.equal(decision.status, "failed");
    assert.equal(decision.errorCode, "RENDER_RECONCILIATION_MANIFEST_INVALID");
  }
});

test("reconciliation preparation rejects missing context result or result hash before mutation", async () => {
  const base = {
    operation: operation(),
    eligibleSegmentIndexes: [1, 2],
    contexts: [
      { episodeIndex: 1, title: "one" },
      { episodeIndex: 2, title: "two" },
    ],
    results: completedJob().result.segments,
    prepareSegment: ({ segmentIndex }) => ({ segmentIndex }),
  };

  for (const invalid of [
    { contexts: base.contexts.slice(0, 1) },
    { contexts: [...base.contexts, base.contexts[1]] },
    { results: base.results.slice(0, 1) },
    { results: base.results.map((item) => item.episodeIndex === 2 ? { ...item, resultHash: undefined } : item) },
  ]) {
    let applyCount = 0;
    let finalizeCount = 0;
    assert.throws(
      () => prepareRenderPackReconciliation({ ...base, ...invalid }),
      /reconciliation/i,
    );
    assert.equal(applyCount, 0);
    assert.equal(finalizeCount, 0);
  }
});

test("preparation is all-or-nothing and successful application finalizes after every segment", async () => {
  const prepareCalls = [];
  const applied = [];
  let finalizeCount = 0;
  const base = {
    operation: operation(),
    eligibleSegmentIndexes: [1, 2],
    contexts: [
      { episodeIndex: 1, title: "one" },
      { episodeIndex: 2, title: "two" },
    ],
    results: completedJob().result.segments,
  };

  assert.throws(
    () => prepareRenderPackReconciliation({
      ...base,
      prepareSegment(item) {
        prepareCalls.push(item.segmentIndex);
        if (item.segmentIndex === 2) throw new Error("quality preparation failed");
        return { segmentIndex: item.segmentIndex };
      },
    }),
    /quality preparation failed/,
  );
  assert.deepEqual(prepareCalls, [1, 2]);
  assert.deepEqual(applied, []);
  assert.equal(finalizeCount, 0);

  const prepared = prepareRenderPackReconciliation({
    ...base,
    prepareSegment: ({ segmentIndex }) => ({ segmentIndex }),
  });
  await applyPreparedRenderPackReconciliation(prepared, {
    async applySegment(action) {
      assert.equal(finalizeCount, 0);
      applied.push(action.segmentIndex);
    },
    async finalize() {
      assert.deepEqual(applied, [1, 2]);
      finalizeCount += 1;
    },
  });
  assert.deepEqual(applied, [1, 2]);
  assert.equal(finalizeCount, 1);
});

test("replay skips reconciliation preparation and quality work", () => {
  const merged = terminateRenderOperation(operation(), {
    state: "merged",
    at: "2026-07-16T00:10:00.000Z",
    finalManifestHash: "manifest-result-1",
    resultHashes: { 1: "result-1", 2: "result-2" },
  });
  const decision = reconcileDetachedRenderPack({
    operation: merged,
    job: completedJob(),
    manifestValidated: true,
    currentSegments: {
      1: { resultHash: "result-1" },
      2: { resultHash: "result-2" },
    },
  });
  let qualityPasses = 0;
  if (decision.status === "merged") {
    prepareRenderPackReconciliation({
      operation: merged,
      eligibleSegmentIndexes: decision.segmentIndexes,
      contexts: [],
      results: [],
      prepareSegment() {
        qualityPasses += 1;
        return {};
      },
    });
  }
  assert.equal(decision.status, "replay");
  assert.equal(qualityPasses, 0);
});

test("pending jobs remain waiting and blocking quality is left to the existing route", () => {
  const waiting = reconcileDetachedRenderPack({
    operation: operation(),
    job: completedJob({ status: "running", stage: "executing", resultAvailable: false, result: undefined }),
    manifestValidated: false,
    currentSegments: currentSegments(),
  });
  assert.deepEqual(waiting, { status: "waiting", stage: "executing" });

  const eligible = reconcileDetachedRenderPack({
    operation: operation(),
    job: completedJob(),
    manifestValidated: true,
    currentSegments: currentSegments(),
  });
  assert.equal(eligible.status, "merged");
  assert.equal("qualityDecision" in eligible, false);
});

test("Dashboard detaches infrastructure timeouts without queuing quality repair", () => {
  const source = readFileSync(new URL("../components/DashboardClient.tsx", import.meta.url), "utf8");
  const branchStart = source.indexOf("if (isRenderPackPollingInfrastructureError(error))");
  const branchEnd = source.indexOf("const reason = error instanceof Error", branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  const branch = source.slice(branchStart, branchEnd);
  assert.match(branch, /detachRenderOperation/);
  assert.match(branch, /RENDER_OPERATION_DETACHED/);
  assert.match(branch, /observeDetachedRenderOperation/);
  assert.doesNotMatch(branch, /queueSegmentRepair/);
});

test("Dashboard routes eligible late results through the existing quality pipeline", () => {
  const source = readFileSync(new URL("../components/DashboardClient.tsx", import.meta.url), "utf8");
  const helperStart = source.indexOf("async function reconcileAndRouteRenderPackResult");
  const helperEnd = source.indexOf("function observeDetachedRenderOperation", helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /reconcileDetachedRenderPack/);
  assert.match(helper, /normalizePatchAndEvaluateBatchSegment/);
  assert.match(helper, /routeBatchSegmentOutcome/);
  assert.match(helper, /storeRenderedEpisode/);
});
