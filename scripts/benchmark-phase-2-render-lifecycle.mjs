import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  applyPreparedRenderPackReconciliation,
  createRenderPackObserverRegistry,
  observeRenderPackJob,
  prepareRenderPackReconciliation,
  reconcileDetachedRenderPack,
  startConcurrentRenderRecoveryObservers,
} = require("../lib/batch-render-reconciliation.ts");
const {
  attachRenderOperationJob,
  createRenderOperationDraft,
  detachRenderOperation,
  terminateRenderOperation,
} = require("../lib/batch-render-operation.ts");

const REQUIRED_PRODUCTION_HELPERS = Object.freeze([
  "observeRenderPackJob",
  "startConcurrentRenderRecoveryObservers",
  "reconcileDetachedRenderPack",
  "prepareRenderPackReconciliation",
  "applyPreparedRenderPackReconciliation",
]);

export async function runPhase2RenderRecoveryHarness({ faults = {} } = {}) {
  const calls = {
    modelCalls: nonNegativeInteger(faults.modelCalls),
    judgeCalls: nonNegativeInteger(faults.judgeCalls),
    repairCalls: nonNegativeInteger(faults.repairCalls),
    fallbackCalls: nonNegativeInteger(faults.fallbackCalls),
    singleGenerationCalls: nonNegativeInteger(faults.singleGenerationCalls),
  };
  const productionHelpersUsed = new Set();
  const observerStartsByJob = {};
  const statusPollsByJob = {};
  const appliedMergeKeys = new Set();
  const operationsByJob = new Map();
  const durableOperationTokens = [];
  let renderJobsCreated = 0;
  let duplicateMergeCount = 0;
  let preparedSegmentCount = 0;
  let finalizedOperations = 0;
  let abortedObservers = 0;
  let remainingTimers = 0;
  let remainingObserverEntries = 0;
  let malformedContextMutationCount = 0;
  let malformedContextRejected = false;

  const markHelper = (name) => productionHelpersUsed.add(name);
  const currentSegments = (operation) => Object.fromEntries(operation.segmentIndexes.map((segmentIndex) => [
    String(segmentIndex),
    {
      operationToken: operation.operationToken,
      sourceHash: operation.sourceHash,
      contractHash: operation.contractHashes[String(segmentIndex)],
    },
  ]));

  const mergeCompletedJob = async (operation, job, scenarioName) => {
    markHelper("reconcileDetachedRenderPack");
    const decision = reconcileDetachedRenderPack({
      operation,
      job,
      manifestValidated: true,
      currentSegments: currentSegments(operation),
    });
    if (decision.status !== "merged") return decision;

    markHelper("prepareRenderPackReconciliation");
    const prepared = prepareRenderPackReconciliation({
      operation,
      eligibleSegmentIndexes: decision.segmentIndexes,
      contexts: operation.reconciliationContext.segments,
      results: job.result.segments,
      prepareSegment({ segmentIndex, context, result, resultHash }) {
        preparedSegmentCount += 1;
        return { segmentIndex, context, result, resultHash, scenarioName };
      },
    });
    markHelper("applyPreparedRenderPackReconciliation");
    await applyPreparedRenderPackReconciliation(prepared, {
      applySegment(action, segmentIndex) {
        if (faults.omitMergeSegment === segmentIndex && scenarioName === "main") return;
        const mergeKey = `${operation.operationToken}:${segmentIndex}`;
        if (appliedMergeKeys.has(mergeKey)) duplicateMergeCount += 1;
        else appliedMergeKeys.add(mergeKey);
        if (action.segmentIndex !== segmentIndex) throw new Error("Prepared Render action identity changed");
      },
      finalize(finalized) {
        finalizedOperations += 1;
        operationsByJob.set(operation.jobId, terminateRenderOperation(operation, {
          state: "merged",
          finalManifestHash: job.resultHash,
          resultHashes: finalized.resultHashes,
        }));
      },
    });
    return decision;
  };

  const createMainOperation = () => {
    const segmentIndexes = [1, 2, 3, 4, 5];
    const operation = createAttachedOperation({
      jobId: "render-job-main",
      operationToken: "render-token-main",
      segmentIndexes,
    });
    const createAdapter = () => {
      renderJobsCreated += 1;
      return operation;
    };
    const created = createAdapter();
    if (faults.duplicateCreate) createAdapter();
    durableOperationTokens.push(created.operationToken);
    operationsByJob.set(created.jobId, created);
    return created;
  };

  const mainOperation = createMainOperation();
  const mainJob = createCompletedJob(mainOperation);
  let mainNow = 0;
  const queueEnd = 23 * 60_000;
  const executionEnd = queueEnd + 8 * 60_000;
  const finalizationEnd = executionEnd + 1_000;
  const readMainJob = async () => {
    increment(statusPollsByJob, mainOperation.jobId);
    if (mainNow < queueEnd) return pendingJob(mainOperation.jobId, "waiting-slot");
    if (mainNow < executionEnd) return pendingJob(mainOperation.jobId, "executing");
    if (mainNow < finalizationEnd) return pendingJob(mainOperation.jobId, "finalizing");
    return mainJob;
  };

  markHelper("observeRenderPackJob");
  const foreground = await observeRenderPackJob({
    jobId: mainOperation.jobId,
    mode: "foreground",
    attentionMs: 12 * 60_000,
    now: () => mainNow,
    readJob: readMainJob,
    sleep: async (delayMs) => { mainNow += delayMs; },
    pollDelay: () => 60_000,
  });
  const foregroundDetached = foreground.status === "detached";
  const detachedMain = foregroundDetached
    ? detachRenderOperation(mainOperation, { at: new Date(mainNow).toISOString(), errorCode: foreground.reasonCode })
    : mainOperation;
  operationsByJob.set(detachedMain.jobId, detachedMain);

  const mainRegistry = createRenderPackObserverRegistry();
  markHelper("startConcurrentRenderRecoveryObservers");
  const mainRecovery = startConcurrentRenderRecoveryObservers({
    operations: [detachedMain],
    registry: mainRegistry,
    observe(operation, signal) {
      increment(observerStartsByJob, operation.jobId);
      markHelper("observeRenderPackJob");
      return observeRenderPackJob({
        jobId: operation.jobId,
        mode: "background",
        signal,
        now: () => mainNow,
        readJob: readMainJob,
        sleep: async (delayMs) => { mainNow += delayMs; },
        pollDelay: () => 60_000,
      });
    },
    async onOutcome(operation, outcome) {
      if (outcome.status === "completed") await mergeCompletedJob(operation, outcome.job, "main");
      if (outcome.status === "aborted") abortedObservers += 1;
    },
  });
  await mainRecovery.settled;
  remainingObserverEntries += mainRegistry.size();

  const refreshOperations = [
    createAttachedOperation({ jobId: "refresh-job-1", operationToken: "refresh-token-1", segmentIndexes: [6] }),
    createAttachedOperation({ jobId: "refresh-job-2", operationToken: "refresh-token-2", segmentIndexes: [7] }),
    createAttachedOperation({ jobId: "refresh-job-3", operationToken: "refresh-token-3", segmentIndexes: [8] }),
  ].map((operation) => detachRenderOperation(operation));
  refreshOperations.forEach((operation) => operationsByJob.set(operation.jobId, operation));
  const refreshRegistry = createRenderPackObserverRegistry();
  const blockingSleep = createAbortableBlockingSleep({
    onStart: () => { remainingTimers += 1; },
    onFinish: () => { remainingTimers -= 1; },
  });
  markHelper("startConcurrentRenderRecoveryObservers");
  const refreshRecovery = startConcurrentRenderRecoveryObservers({
    operations: refreshOperations,
    registry: refreshRegistry,
    observe(operation, signal) {
      increment(observerStartsByJob, operation.jobId);
      markHelper("observeRenderPackJob");
      return observeRenderPackJob({
        jobId: operation.jobId,
        mode: "background",
        signal,
        readJob: async () => {
          const poll = increment(statusPollsByJob, operation.jobId);
          if (operation.jobId === "refresh-job-1") return pendingJob(operation.jobId, "waiting-slot");
          if (operation.jobId === "refresh-job-3" && poll === 1) {
            throw Object.assign(new Error("temporary status outage"), { status: 503 });
          }
          return createCompletedJob(operation);
        },
        sleep: operation.jobId === "refresh-job-1" ? blockingSleep : async () => {},
        pollDelay: () => operation.jobId === "refresh-job-1" ? 60_000 : 0,
      });
    },
    async onOutcome(operation, outcome) {
      if (outcome.status === "completed") await mergeCompletedJob(operation, outcome.job, "refresh");
      if (outcome.status === "aborted") abortedObservers += 1;
    },
  });
  await Promise.all([
    refreshRecovery.observers.find((entry) => entry.jobId === "refresh-job-2").promise,
    refreshRecovery.observers.find((entry) => entry.jobId === "refresh-job-3").promise,
  ]);
  const refreshNoHeadOfLineBlocking = !appliedMergeKeys.has("refresh-token-1:6")
    && appliedMergeKeys.has("refresh-token-2:7")
    && appliedMergeKeys.has("refresh-token-3:8");
  refreshRegistry.abortAll();
  await refreshRecovery.settled;
  remainingObserverEntries += refreshRegistry.size();

  const remountOperation = detachRenderOperation(createAttachedOperation({
    jobId: "remount-job",
    operationToken: "remount-token",
    segmentIndexes: [9],
  }));
  const firstMountRegistry = createRenderPackObserverRegistry();
  const firstMountSleep = createAbortableBlockingSleep({
    onStart: () => { remainingTimers += 1; },
    onFinish: () => { remainingTimers -= 1; },
  });
  markHelper("startConcurrentRenderRecoveryObservers");
  const firstMount = startConcurrentRenderRecoveryObservers({
    operations: [remountOperation],
    registry: firstMountRegistry,
    observe(operation, signal) {
      increment(observerStartsByJob, operation.jobId);
      markHelper("observeRenderPackJob");
      return observeRenderPackJob({
        jobId: operation.jobId,
        mode: "background",
        signal,
        readJob: async () => {
          increment(statusPollsByJob, operation.jobId);
          return pendingJob(operation.jobId, "waiting-slot");
        },
        sleep: firstMountSleep,
        pollDelay: () => 60_000,
      });
    },
    onOutcome(_operation, outcome) {
      if (outcome.status === "aborted") abortedObservers += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  firstMountRegistry.abortAll();
  await firstMount.settled;
  remainingObserverEntries += firstMountRegistry.size();

  const remountRegistry = createRenderPackObserverRegistry();
  markHelper("startConcurrentRenderRecoveryObservers");
  const remount = startConcurrentRenderRecoveryObservers({
    operations: [remountOperation],
    registry: remountRegistry,
    observe(operation, signal) {
      increment(observerStartsByJob, operation.jobId);
      markHelper("observeRenderPackJob");
      return observeRenderPackJob({
        jobId: operation.jobId,
        mode: "background",
        signal,
        readJob: async () => {
          increment(statusPollsByJob, operation.jobId);
          return createCompletedJob(operation);
        },
        sleep: async () => {},
      });
    },
    async onOutcome(operation, outcome) {
      if (outcome.status === "completed") await mergeCompletedJob(operation, outcome.job, "remount");
    },
  });
  await remount.settled;
  remainingObserverEntries += remountRegistry.size();

  try {
    createRenderOperationDraft({
      batchId: "malformed-context-batch",
      operationToken: "malformed-context-token",
      segmentIndexes: [10, 11],
      contractHashes: { 10: "contract-10", 11: "contract-11" },
      reconciliationContext: {
        sourceText: "source",
        segments: [{ episodeIndex: 10, title: "ten", sourceText: "ten", duration: "15 seconds" }],
      },
    });
    malformedContextMutationCount += 1;
  } catch {
    malformedContextRejected = true;
  }

  const mainScenarioMergedSegments = [...appliedMergeKeys]
    .filter((key) => key.startsWith(`${mainOperation.operationToken}:`)).length;
  const remountMergeCount = [...appliedMergeKeys]
    .filter((key) => key.startsWith(`${remountOperation.operationToken}:`)).length;

  return {
    queueWaitMs: queueEnd,
    executionMs: 8 * 60_000,
    renderJobsCreated,
    durableOperationTokens,
    foregroundDetached,
    observerStartsByJob,
    statusPollsByJob,
    mainScenarioMergedSegments,
    mergedSegmentCount: appliedMergeKeys.size,
    preparedSegmentCount,
    finalizedOperations,
    duplicateMergeCount,
    refreshNoHeadOfLineBlocking,
    remountMergeCount,
    abortedObservers,
    malformedContextRejected,
    malformedContextMutationCount,
    remainingTimers,
    remainingObserverEntries,
    productionHelpersUsed: [...productionHelpersUsed].sort(),
    ...calls,
  };
}

export function createPhase2LifecycleReport({ scenario, physicalCoordinator }) {
  const helperSet = new Set(scenario.productionHelpersUsed || []);
  const checks = {
    productionRecoveryHelpersUsed: REQUIRED_PRODUCTION_HELPERS.every((helper) => helperSet.has(helper)),
    oneRenderJobCreated: scenario.renderJobsCreated === 1,
    oneDurableOperationToken: scenario.durableOperationTokens?.length === 1,
    foregroundDetached: scenario.foregroundDetached === true,
    oneBackgroundObserver: scenario.observerStartsByJob?.["render-job-main"] === 1,
    completeMainMerge: scenario.mainScenarioMergedSegments === 5,
    noDuplicateMerge: scenario.duplicateMergeCount === 0,
    prepareBeforeApply: scenario.preparedSegmentCount === scenario.mergedSegmentCount,
    refreshHasNoHeadOfLineBlocking: scenario.refreshNoHeadOfLineBlocking === true,
    transientRefreshRetried: scenario.statusPollsByJob?.["refresh-job-3"] === 2,
    remountMergedOnce: scenario.remountMergeCount === 1,
    malformedContextRejectedBeforeMutation: scenario.malformedContextRejected === true
      && scenario.malformedContextMutationCount === 0,
    observerCleanupComplete: scenario.remainingTimers === 0 && scenario.remainingObserverEntries === 0,
    noModelOrFallbackCalls: [
      scenario.modelCalls,
      scenario.judgeCalls,
      scenario.repairCalls,
      scenario.fallbackCalls,
      scenario.singleGenerationCalls,
    ].every((value) => value === 0),
    physicalCallerCount: physicalCoordinator.callers === 100,
    physicalCoordinatorWithinBudget: physicalCoordinator.elapsedMs < 45_000,
    physicalConcurrencyExactlyFour: physicalCoordinator.maxActive === 4,
    physicalAuxiliaryAdmissionCap: physicalCoordinator.maxNonOriginalWithOriginalDemand <= 1,
    physicalNoStarvationOrTimeout: physicalCoordinator.starvationCount === 0
      && physicalCoordinator.lockTimeoutCount === 0,
    physicalCoordinatorClean: physicalCoordinator.remainingWaiters === 0
      && physicalCoordinator.remainingLeases === 0,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([check]) => check);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    productionHelpersUsed: [...helperSet].sort(),
    scenario,
    physicalCoordinator,
    checks,
    failedChecks,
    status: failedChecks.length === 0 ? "accepted" : "rejected",
  };
}

export async function runPhysicalCodexCoordinatorScenario() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "localdirector-phase2r-lifecycle-slot-"));
  const keys = [
    "CODEX_CLI_SLOT_ROOT_DIR",
    "CODEX_CLI_MAX_SLOTS",
    "CODEX_CLI_SLOT_POLL_MS",
    "CODEX_CLI_SLOT_LOCK_WAIT_MS",
    "CODEX_FAIR_SCHEDULER_V2",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CODEX_CLI_SLOT_ROOT_DIR: rootDir,
    CODEX_CLI_MAX_SLOTS: "4",
    CODEX_CLI_SLOT_POLL_MS: "25",
    CODEX_CLI_SLOT_LOCK_WAIT_MS: "10000",
    CODEX_FAIR_SCHEDULER_V2: "1",
  });
  let active = 0;
  let maxActive = 0;
  let activeNonOriginal = 0;
  let maxNonOriginalWithOriginalDemand = 0;
  let renderOutstanding = 75;
  let completed = 0;
  const startedAt = Date.now();
  try {
    const coordinatorUrl = `${pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-cli-slot-coordinator.mjs")).href}?lifecycle=${Date.now()}`;
    const coordinator = await import(coordinatorUrl);
    const calls = Array.from({ length: 100 }, (_, index) => {
      const taskClass = index < 75 ? "render_pack" : "path_repair";
      return coordinator.withCodexCliSlot(taskClass, `lifecycle-${index}`, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (taskClass !== "render_pack") {
          activeNonOriginal += 1;
          if (renderOutstanding > 0) {
            maxNonOriginalWithOriginalDemand = Math.max(
              maxNonOriginalWithOriginalDemand,
              activeNonOriginal,
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (taskClass === "render_pack") renderOutstanding -= 1;
        else activeNonOriginal -= 1;
        active -= 1;
        completed += 1;
      });
    });
    const outcomes = await Promise.allSettled(calls);
    const state = await coordinator.inspectCodexCliSlotState();
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const lockTimeoutCount = rejected.filter((outcome) => /coordinator state lock/i.test(String(outcome.reason))).length;
    return {
      callers: 100,
      completed,
      elapsedMs: Date.now() - startedAt,
      maxActive,
      maxNonOriginalWithOriginalDemand,
      starvationCount: 100 - completed,
      rejectedCount: rejected.length,
      lockTimeoutCount,
      remainingWaiters: state.waiters.length,
      remainingLeases: state.leases.length,
    };
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}

function createAttachedOperation({ jobId, operationToken, segmentIndexes }) {
  const contractHashes = Object.fromEntries(segmentIndexes.map((segmentIndex) => [
    String(segmentIndex),
    `contract-${segmentIndex}`,
  ]));
  const draft = createRenderOperationDraft({
    batchId: `batch-${operationToken}`,
    operationToken,
    segmentIndexes,
    contractHashes,
    now: "2026-07-16T00:00:00.000Z",
    reconciliationContext: {
      sourceText: `source-${operationToken}`,
      segments: segmentIndexes.map((episodeIndex) => ({
        episodeIndex,
        title: `Segment ${episodeIndex}`,
        sourceText: `Source ${episodeIndex}`,
        duration: "15 seconds",
      })),
    },
  });
  return attachRenderOperationJob(draft, {
    jobId,
    sourceHash: `source-${operationToken}`,
    aggregateContractHash: draft.aggregateContractHash,
  });
}

function createCompletedJob(operation) {
  return {
    id: operation.jobId,
    protocolVersion: 2,
    status: "completed",
    stage: "completed",
    resultAvailable: true,
    batchId: operation.batchId,
    operationToken: operation.operationToken,
    sourceHash: operation.sourceHash,
    aggregateContractHash: operation.aggregateContractHash,
    segmentIndexes: [...operation.segmentIndexes],
    contractHashes: { ...operation.contractHashes },
    resultHash: `manifest-${operation.operationToken}`,
    result: {
      segments: operation.segmentIndexes.map((episodeIndex) => ({
        episodeIndex,
        resultHash: `result-${operation.operationToken}-${episodeIndex}`,
        result: { episodeIndex, title: `Segment ${episodeIndex}` },
      })),
    },
  };
}

function pendingJob(jobId, stage) {
  return { id: jobId, status: stage === "executing" ? "running" : "pending", stage };
}

function createAbortableBlockingSleep({ onStart, onFinish }) {
  return (_delayMs, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    onStart();
    signal?.addEventListener("abort", () => {
      onFinish();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
    void resolve;
  });
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
  return record[key];
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((value) => value.startsWith("--")).map((value) => {
    const [key, ...rest] = value.slice(2).split("=");
    return [key, rest.join("=") || "true"];
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(args.output || path.join(
    process.cwd(),
    ".tmp-task-one-evidence",
    "phase-2r-final",
    "lifecycle-integration.json",
  ));
  try {
    const scenario = await runPhase2RenderRecoveryHarness();
    const physicalCoordinator = await runPhysicalCodexCoordinatorScenario();
    const report = createPhase2LifecycleReport({ scenario, physicalCoordinator });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== "accepted") process.exitCode = 1;
  } catch (error) {
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      status: "rejected",
      failedChecks: ["lifecycleHarnessExecution"],
      error: error instanceof Error ? error.message : String(error),
    };
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stderr.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}
