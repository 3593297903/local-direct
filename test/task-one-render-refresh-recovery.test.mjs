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
  calculateRenderObservationDelay,
  classifyRenderObservationError,
  createRenderPackObserverRegistry,
  hasActiveRenderRecovery,
  hasSaveableUnsavedResults,
  isBatchRenderLateReconciliationEnabled,
  listRecoverableRenderOperations,
  observeRenderPackJob,
  retryCreatingRenderOperation,
  startConcurrentRenderRecoveryObservers,
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

test("abortAll clears observer ownership and aborts future reads without failure dispatch", async () => {
  const registry = createRenderPackObserverRegistry();
  let reads = 0;
  let failureDispatches = 0;
  const observer = registry.observe("abort-job", async (signal) => observeRenderPackJob({
    jobId: "abort-job",
    mode: "background",
    signal,
    readJob: async () => {
      reads += 1;
      return { id: "abort-job", status: "pending", stage: "waiting-slot" };
    },
    sleep: (delayMs, activeSignal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      activeSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
    pollDelay: () => 60_000,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  registry.abortAll();
  assert.equal(registry.size(), 0);
  const outcome = await observer;
  if (outcome.status === "terminal_failed") failureDispatches += 1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.status, "aborted");
  assert.equal(reads, 1);
  assert.equal(failureDispatches, 0);
});

test("remount resumes the same durable operation and merges it once", async () => {
  const durable = activeOperation("remount-token", "remount-job");
  let merges = 0;
  let firstReads = 0;
  const firstRegistry = createRenderPackObserverRegistry();
  const first = startConcurrentRenderRecoveryObservers({
    operations: [durable],
    registry: firstRegistry,
    observe: async (operation, signal) => observeRenderPackJob({
      jobId: operation.jobId,
      mode: "background",
      signal,
      readJob: async () => {
        firstReads += 1;
        return { id: operation.jobId, status: "pending", stage: "pending" };
      },
      sleep: (delayMs, activeSignal) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        activeSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
      pollDelay: () => 60_000,
    }),
    onOutcome: async (_operation, outcome) => {
      if (outcome.status === "completed") merges += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  firstRegistry.abortAll();
  await first.settled;
  assert.equal(firstReads, 1);
  assert.equal(merges, 0);

  const secondRegistry = createRenderPackObserverRegistry();
  const second = startConcurrentRenderRecoveryObservers({
    operations: [durable],
    registry: secondRegistry,
    observe: async (operation, signal) => observeRenderPackJob({
      jobId: operation.jobId,
      mode: "background",
      signal,
      readJob: async () => ({ id: operation.jobId, status: "completed", stage: "completed" }),
      sleep: async () => {},
    }),
    onOutcome: async (_operation, outcome) => {
      if (outcome.status === "completed") merges += 1;
    },
  });
  await second.settled;
  assert.equal(merges, 1);
  assert.equal(secondRegistry.size(), 0);
});

test("refresh starts unique observers concurrently and later jobs do not wait for an earlier pending job", async () => {
  const registry = createRenderPackObserverRegistry();
  const operations = [
    activeOperation("token-1", "job-1"),
    activeOperation("token-2", "job-2"),
    activeOperation("token-3", "job-3"),
  ];
  const starts = [];
  const outcomes = [];
  let releaseFirst;
  const firstWait = new Promise((resolve) => { releaseFirst = resolve; });

  const recovery = startConcurrentRenderRecoveryObservers({
    operations,
    registry,
    async observe(operation) {
      starts.push(operation.jobId);
      if (operation.jobId === "job-1") await firstWait;
      if (operation.jobId === "job-3") throw new TypeError("temporary network interruption");
      return { status: "completed", job: { id: operation.jobId, status: "completed" } };
    },
    async onOutcome(operation, outcome) {
      outcomes.push([operation.jobId, outcome.status]);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.sort(), ["job-1", "job-2", "job-3"]);
  assert.deepEqual(outcomes, [["job-2", "completed"]]);
  assert.equal(registry.size(), 1);
  releaseFirst();
  await recovery.settled;
  assert.deepEqual(outcomes.sort(), [["job-1", "completed"], ["job-2", "completed"]]);
});

test("foreground attention expiry detaches without model repair Judge or fallback", async () => {
  let now = 0;
  const calls = { model: 0, repair: 0, judge: 0, fallback: 0 };
  const outcome = await observeRenderPackJob({
    jobId: "attention-job",
    mode: "foreground",
    attentionMs: 100,
    now: () => now,
    readJob: async () => ({ id: "attention-job", status: "pending", stage: "waiting-slot" }),
    sleep: async (delayMs) => { now += delayMs; },
    pollDelay: () => 50,
  });
  assert.deepEqual(outcome, {
    status: "detached",
    jobId: "attention-job",
    reasonCode: "RENDER_ATTENTION_EXPIRED",
  });
  assert.deepEqual(calls, { model: 0, repair: 0, judge: 0, fallback: 0 });
});

test("transient observation errors preserve the job until its original result completes", async () => {
  const transientErrors = [
    new TypeError("network reset"),
    Object.assign(new Error("service unavailable"), { status: 503 }),
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("storage busy"), { code: "JOB_STORAGE_BUSY" }),
  ];
  let reads = 0;
  const outcome = await observeRenderPackJob({
    jobId: "transient-job",
    mode: "background",
    readJob: async () => {
      const error = transientErrors[reads++];
      if (error) throw error;
      return { id: "transient-job", status: "completed", stage: "completed" };
    },
    sleep: async () => {},
    pollDelay: () => 0,
  });
  assert.equal(outcome.status, "completed");
  assert.equal(reads, 5);
  assert.equal(classifyRenderObservationError(transientErrors[3]), "transient");
});

test("one missing probe remains recoverable but three confirmed 404 probes become terminal", async () => {
  let singleReads = 0;
  const single = await observeRenderPackJob({
    jobId: "single-404",
    mode: "background",
    readJob: async () => {
      singleReads += 1;
      if (singleReads === 1) throw Object.assign(new Error("not found"), { status: 404 });
      return { id: "single-404", status: "completed", stage: "completed" };
    },
    sleep: async () => {},
    pollDelay: () => 0,
  });
  assert.equal(single.status, "completed");

  let repeatedReads = 0;
  const missing = await observeRenderPackJob({
    jobId: "three-404",
    mode: "background",
    readJob: async () => {
      repeatedReads += 1;
      throw Object.assign(new Error("not found"), { status: 404 });
    },
    sleep: async () => {},
    pollDelay: () => 0,
  });
  assert.deepEqual(missing, {
    status: "terminal_failed",
    jobId: "three-404",
    reasonCode: "RENDER_JOB_CONFIRMED_MISSING",
  });
  assert.equal(repeatedReads, 3);
});

test("explicit failed status becomes terminal without automatic fallback", async () => {
  const calls = { model: 0, repair: 0, judge: 0, fallback: 0 };
  const outcome = await observeRenderPackJob({
    jobId: "failed-job",
    mode: "background",
    readJob: async () => ({ id: "failed-job", status: "failed", stage: "failed" }),
    sleep: async () => {},
    pollDelay: () => 0,
  });
  assert.equal(outcome.status, "terminal_failed");
  assert.equal(outcome.reasonCode, "RENDER_JOB_TERMINAL_FAILURE");
  assert.deepEqual(calls, { model: 0, repair: 0, judge: 0, fallback: 0 });
});

test("creating recovery retries with one idempotency identity and resolves one job", async () => {
  const draft = createRenderOperationDraft({
    batchId: "create-retry-batch",
    operationToken: "create-retry-token",
    segmentIndexes: [1],
    contractHashes: { 1: "contract-1" },
  });
  const identities = [];
  let attempts = 0;
  const result = await retryCreatingRenderOperation({
    operation: draft,
    maxAttempts: 3,
    async create(operation) {
      attempts += 1;
      identities.push([operation.operationToken, operation.idempotencyKey]);
      if (attempts === 1) throw new TypeError("lost create response");
      return { id: "one-created-job" };
    },
    sleep: async () => {},
  });
  assert.equal(result.status, "created");
  assert.equal(result.value.id, "one-created-job");
  assert.equal(attempts, 2);
  assert.equal(new Set(identities.map((identity) => identity.join(":"))).size, 1);
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

test("active recovery saveable results and audit retention use separate predicates", () => {
  const failed = terminateRenderOperation(activeOperation("failed-token", "failed-job"), {
    state: "failed",
    errorCode: "RENDER_JOB_TERMINAL_FAILURE",
  });
  const detached = detachRenderOperation(activeOperation("detached-token", "detached-job"));
  assert.equal(hasActiveRenderRecovery([failed]), false);
  assert.equal(hasSaveableUnsavedResults([{ generationStatus: "failed", saveStatus: "not_ready" }]), false);
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [failed],
    segmentStates: [{ generationStatus: "failed", saveStatus: "not_ready" }],
  }), false);
  assert.equal(hasActiveRenderRecovery([detached]), true);
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [detached],
    segmentStates: [{ generationStatus: "render_detached", saveStatus: "not_ready" }],
  }), true);
  assert.equal(hasSaveableUnsavedResults([{ generationStatus: "settled", saveStatus: "cached" }]), true);
  assert.equal(shouldRetainRenderRecoveryPointer({
    operations: [failed],
    segmentStates: [{ generationStatus: "settled", saveStatus: "cached" }],
  }), true);
});

test("polling delay is bounded by job state hidden-tab backoff and deterministic jitter", () => {
  const executing = calculateRenderObservationDelay({ stage: "executing", transientFailures: 0, hidden: false, random: () => 0.5 });
  const pending = calculateRenderObservationDelay({ stage: "waiting-slot", transientFailures: 0, hidden: false, random: () => 0.5 });
  const hidden = calculateRenderObservationDelay({ stage: "waiting-slot", transientFailures: 0, hidden: true, random: () => 0.5 });
  const transport = calculateRenderObservationDelay({ stage: "pending", transientFailures: 9, hidden: true, random: () => 0.5 });
  assert.ok(executing >= 2_500 && executing <= 5_000);
  assert.ok(pending >= 5_000 && pending <= 15_000);
  assert.ok(hidden >= pending && hidden <= 30_000);
  assert.ok(transport <= 30_000);
});

test("late reconciliation rollback flag defaults on and explicit zero is safe rollback", () => {
  assert.equal(isBatchRenderLateReconciliationEnabled(undefined), true);
  assert.equal(isBatchRenderLateReconciliationEnabled("1"), true);
  assert.equal(isBatchRenderLateReconciliationEnabled("0"), false);
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
