import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createRenderPackObserverRegistry,
  listRecoverableRenderOperations,
  shouldRetainRenderRecoveryPointer,
} = require("../lib/batch-render-reconciliation.ts");
const {
  createRenderOperationDraft,
  attachRenderOperationJob,
  detachRenderOperation,
  terminateRenderOperation,
} = require("../lib/batch-render-operation.ts");
const {
  createVideoPromptPackCodexJob,
  toVideoPromptPackCodexJobStatusDto,
} = require("../lib/video-prompt-pack-codex-queue.ts");

function activeOperation(token = "refresh-token-1", jobId = "refresh-job-1") {
  const draft = createRenderOperationDraft({
    batchId: "refresh-batch-1",
    operationToken: token,
    segmentIndexes: [1, 2],
    contractHashes: { 1: "contract-1", 2: "contract-2" },
    now: "2026-07-16T00:00:00.000Z",
  });
  return attachRenderOperationJob(draft, {
    jobId,
    sourceHash: "source-1",
    aggregateContractHash: draft.aggregateContractHash,
  });
}

test("refresh recovery returns one observer target per active Render Pack job", () => {
  const first = activeOperation();
  const duplicateAudit = { ...first, createdAt: "2026-07-16T00:01:00.000Z", state: "detached" };
  const merged = terminateRenderOperation(activeOperation("refresh-token-2", "refresh-job-2"), {
    state: "merged",
    finalManifestHash: "manifest-2",
    resultHashes: { 1: "result-1", 2: "result-2" },
  });
  const targets = listRecoverableRenderOperations([first, duplicateAudit, merged]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].jobId, "refresh-job-1");
  assert.equal(targets[0].state, "detached");
});

test("observer registry deduplicates concurrent observers by job id", async () => {
  const registry = createRenderPackObserverRegistry();
  let starts = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const first = registry.observe("job-1", async () => { starts += 1; await wait; return "done"; });
  const second = registry.observe("job-1", async () => { starts += 1; return "duplicate"; });
  assert.equal(first, second);
  assert.equal(registry.size(), 1);
  release();
  assert.equal(await first, "done");
  await Promise.resolve();
  assert.equal(registry.size(), 0);
  assert.equal(starts, 1);
});

test("recovery pointer remains while an active operation or unresolved segment exists", () => {
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [activeOperation()],
    segmentStates: [{ generationStatus: "render_detached", saveStatus: "not_ready" }],
  }), true);
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [],
    segmentStates: [{ generationStatus: "settled", saveStatus: "cached" }],
  }), true);
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [],
    segmentStates: [{ generationStatus: "settled", saveStatus: "saved" }],
  }), false);
});

test("pending Render Pack status is smaller than 4 KiB", async () => {
  const rootDir = path.join(os.tmpdir(), `phase-2-status-${Date.now()}-${Math.random()}`);
  try {
    const draft = createRenderOperationDraft({
      batchId: "status-batch",
      operationToken: "status-token",
      segmentIndexes: [1, 2, 3, 4, 5],
      contractHashes: { 1: "c1", 2: "c2", 3: "c3", 4: "c4", 5: "c5" },
    });
    const job = await createVideoPromptPackCodexJob({
      batchId: draft.batchId,
      operationToken: draft.operationToken,
      idempotencyKey: draft.idempotencyKey,
      segments: draft.segmentIndexes.map((episodeIndex) => ({
        episodeIndex,
        title: `Segment ${episodeIndex}`,
        script: "source ".repeat(200),
        renderInputScript: "render instructions ".repeat(200),
        duration: "15 seconds",
        segmentContract: { contractHash: draft.contractHashes[String(episodeIndex)] },
      })),
    }, { rootDir });
    const bytes = Buffer.byteLength(JSON.stringify(toVideoPromptPackCodexJobStatusDto(job)), "utf8");
    assert.ok(bytes < 4096, `status payload was ${bytes} bytes`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Dashboard discovers active Render operations before creating a new Season Pack", () => {
  const source = readFileSync(new URL("../components/DashboardClient.tsx", import.meta.url), "utf8");
  const runStart = source.indexOf("async function runBatchEpisodeGeneration()");
  const discovery = source.indexOf("ensureBatchSaveRecoveryDiscovery()", runStart);
  const seasonPost = source.indexOf("runSeasonPackPlanningWithLockedRetry", runStart);
  assert.ok(runStart > 0 && discovery > runStart && seasonPost > discovery);
  assert.match(source, /resumeCachedRenderOperations/);
});
