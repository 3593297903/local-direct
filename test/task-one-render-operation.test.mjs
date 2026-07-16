import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  attachRenderOperationJob,
  buildRenderOperationIdempotencyKey,
  createRenderOperationDraft,
  retainBoundedRenderOperationAudits,
  terminateRenderOperation,
} = require("../lib/batch-render-operation.ts");
const {
  createInitialSegmentState,
  reduceSegmentState,
} = require("../lib/batch-segment-progress.ts");
const {
  readSegmentBatchCache,
  writeSegmentBatchCache,
} = require("../lib/segment-batch-cache.ts");
const {
  createVideoPromptPackCodexJob,
  toVideoPromptPackCodexJobStatusDto,
} = require("../lib/video-prompt-pack-codex-queue.ts");

function identityInput(overrides = {}) {
  const segmentIndexes = overrides.segmentIndexes || [3, 1, 2];
  const reconciliationContext = overrides.reconciliationContext || {
    sourceText: "source",
    segments: [...new Set(segmentIndexes)].sort((left, right) => left - right).map((episodeIndex) => ({
      episodeIndex,
      title: `segment ${episodeIndex}`,
      sourceText: `source ${episodeIndex}`,
      duration: "15s",
    })),
  };
  return {
    batchId: "batch-operation-1",
    operationToken: "render-operation-token-1",
    segmentIndexes,
    sourceHash: "source-hash-1",
    contractHashes: { 1: "contract-1", 2: "contract-2", 3: "contract-3" },
    reconciliationContext,
    now: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function sampleSegment(index = 1) {
  return {
    episodeIndex: index,
    title: `Segment ${index}`,
    script: `Source text for segment ${index}.`,
    renderInputScript: `Render segment ${index} as a complete executable prompt.`,
    duration: "15 seconds",
    segmentContract: { contractHash: `contract-${index}` },
  };
}

test("operation draft is durable before POST and keeps one batch-level identity", async () => {
  const rootDir = path.join(os.tmpdir(), `render-operation-cache-${Date.now()}-${Math.random()}`);
  try {
    const draft = createRenderOperationDraft(identityInput());
    assert.equal(draft.state, "creating");
    assert.equal(draft.jobId, undefined);
    assert.deepEqual(draft.segmentIndexes, [1, 2, 3]);
    assert.equal(draft.idempotencyKey, buildRenderOperationIdempotencyKey(draft));

    const cache = {
      schemaVersion: 2,
      revision: 1,
      batchId: draft.batchId,
      durableBatchId: draft.batchId,
      sourceHash: draft.sourceHash,
      contractHash: draft.aggregateContractHash,
      resolvedSegmentCount: 3,
      updatedAt: draft.createdAt,
      segmentStates: [],
      activeJobIds: [],
      renderOperations: [draft],
      qualityReports: [],
      segments: [],
      needsReviewSegments: [],
    };
    await writeSegmentBatchCache(cache, { rootDir });
    const restored = await readSegmentBatchCache(draft.batchId, { rootDir });
    assert.deepEqual(restored.renderOperations, [draft]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("lost create response reuses operation idempotency and creates one queue job", async () => {
  const rootDir = path.join(os.tmpdir(), `render-operation-queue-${Date.now()}-${Math.random()}`);
  const draft = createRenderOperationDraft(identityInput({
    segmentIndexes: [1],
    contractHashes: { 1: "contract-1" },
  }));
  const input = {
    batchId: draft.batchId,
    operationToken: draft.operationToken,
    idempotencyKey: draft.idempotencyKey,
    segments: [sampleSegment(1)],
  };
  try {
    const first = await createVideoPromptPackCodexJob(input, { rootDir });
    const retry = await createVideoPromptPackCodexJob(input, { rootDir });
    assert.equal(retry.id, first.id);

    const observing = attachRenderOperationJob(draft, {
      jobId: first.id,
      sourceHash: first.sourceHash,
      aggregateContractHash: first.contractHash,
    });
    assert.equal(observing.state, "observing");
    assert.equal(observing.jobId, first.id);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("create and status roundtrip preserve exact reconciliation identity", async () => {
  const rootDir = path.join(os.tmpdir(), `render-operation-status-${Date.now()}-${Math.random()}`);
  const draft = createRenderOperationDraft(identityInput({
    segmentIndexes: [2, 1],
    contractHashes: { 1: "contract-1", 2: "contract-2" },
  }));
  try {
    const job = await createVideoPromptPackCodexJob({
      batchId: draft.batchId,
      operationToken: draft.operationToken,
      idempotencyKey: draft.idempotencyKey,
      segments: [sampleSegment(1), sampleSegment(2)],
    }, { rootDir });
    const status = toVideoPromptPackCodexJobStatusDto(job);
    assert.equal(status.batchId, draft.batchId);
    assert.equal(status.operationToken, draft.operationToken);
    assert.equal(status.sourceHash, job.sourceHash);
    assert.equal(status.aggregateContractHash, job.contractHash);
    assert.deepEqual(status.segmentIndexes, [1, 2]);
    assert.deepEqual(status.contractHashes, { 1: "contract-1", 2: "contract-2" });
    assert.equal("prompt" in status, false);
    assert.equal("outputTemplate" in status, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Render detach preserves quality, save, and repair state", () => {
  let state = createInitialSegmentState(1, { contractHash: "contract-1", updatedAt: 1 });
  state = reduceSegmentState(state, {
    type: "RENDER_OPERATION_CREATED",
    operationToken: "render-token",
    expectedContractHash: "contract-1",
    at: 2,
  });
  state = { ...state, qualityStatus: "passed", saveStatus: "cached", activeRepairJobId: "repair-1" };
  const detached = reduceSegmentState(state, {
    type: "RENDER_OPERATION_DETACHED",
    operationToken: "render-token",
    jobId: "render-job-1",
    at: 3,
  });
  assert.equal(detached.generationStatus, "render_detached");
  assert.equal(detached.qualityStatus, "passed");
  assert.equal(detached.saveStatus, "cached");
  assert.equal(detached.activeRepairJobId, "repair-1");
  assert.equal(detached.activeRenderPackJobId, "render-job-1");
});

test("terminal operation audits are bounded and remove reconciliation context", () => {
  const operations = Array.from({ length: 105 }, (_, index) => terminateRenderOperation(
    createRenderOperationDraft(identityInput({
      operationToken: `token-${String(index).padStart(3, "0")}`,
      now: new Date(index * 1000).toISOString(),
    })),
    { state: "ignored", at: new Date(index * 1000 + 1).toISOString(), reasonCode: "STALE" },
  ));
  const retained = retainBoundedRenderOperationAudits(operations);
  assert.equal(retained.length, 100);
  assert.equal(retained[0].operationToken, "token-005");
  assert.equal(retained.every((item) => item.reconciliationContext === undefined), true);
});

test("malformed operation identity is rejected before queue creation", () => {
  assert.throws(
    () => createRenderOperationDraft(identityInput({ operationToken: "bad token with spaces" })),
    /operationToken/i,
  );
  assert.throws(
    () => createRenderOperationDraft(identityInput({ segmentIndexes: [1, 1] })),
    /segmentIndexes/i,
  );
});

test("reconciliation context must cover every operation segment exactly once", () => {
  assert.throws(
    () => createRenderOperationDraft(identityInput({
      reconciliationContext: {
        sourceText: "source",
        segments: [
          { episodeIndex: 1, title: "one", sourceText: "source one", duration: "15s" },
          { episodeIndex: 2, title: "two", sourceText: "source two", duration: "15s" },
        ],
      },
    })),
    /reconciliationContext.*segmentIndexes/i,
  );

  assert.throws(
    () => createRenderOperationDraft(identityInput({
      reconciliationContext: {
        sourceText: "source",
        segments: [
          { episodeIndex: 1, title: "one", sourceText: "source one", duration: "15s" },
          { episodeIndex: 2, title: "two", sourceText: "source two", duration: "15s" },
          { episodeIndex: 2, title: "two again", sourceText: "source two again", duration: "15s" },
        ],
      },
    })),
    /reconciliationContext.*segmentIndexes/i,
  );

  assert.throws(
    () => createRenderOperationDraft(identityInput({
      reconciliationContext: {
        sourceText: "source",
        segments: [
          { episodeIndex: 1, title: "one", sourceText: "source one", duration: "15s" },
          { episodeIndex: 2, title: "two", sourceText: "source two", duration: "15s" },
          { episodeIndex: 4, title: "four", sourceText: "source four", duration: "15s" },
        ],
      },
    })),
    /reconciliationContext.*segment/i,
  );
});

test("Dashboard persists the operation draft before the Render Pack POST", () => {
  const source = readFileSync(path.join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const start = source.indexOf("async function renderPackedSegmentsWithQualityRepair");
  const end = source.indexOf("await restoreCachedRenderedSegments", start);
  const body = source.slice(start, end);
  const draft = body.indexOf("createRenderOperationDraft(");
  const durableWrite = body.indexOf("await writeBatchSegmentCache()", draft);
  const post = body.indexOf("createVideoPromptPackCodexJob(", durableWrite);
  assert.ok(draft >= 0 && durableWrite > draft && post > durableWrite);
  assert.match(body, /operationToken:\s*durableRenderOperation\.operationToken/);
  assert.match(source, /renderOperations:\s*retainBoundedRenderOperationAudits\(renderOperationRecords\)/);
});

test("browser Render operation identity has no Node-only finalization dependency", () => {
  const source = readFileSync(path.join(process.cwd(), "lib", "batch-render-operation.ts"), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(source, /codex-job-finalization/);
  assert.match(source, /hashCanonicalJsonPortable/);
  assert.match(source, /sha256TextPortable/);
});
