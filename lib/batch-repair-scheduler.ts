export const REPAIR_FRONTEND_WAIT_TIMEOUT_MS = 12 * 60_000;

export type BatchRepairSchedulerTask<T> = {
  segmentIndex: number;
  fingerprint: string;
  payload: T;
};

export type BatchRepairSchedulerSnapshot = {
  queuedCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  knownFingerprints: number;
  idle: boolean;
};

export function createBatchRepairScheduler<T, R = unknown>(input: {
  maxConcurrency?: number;
  execute: (task: BatchRepairSchedulerTask<T>) => Promise<R>;
  onStarted?: (task: BatchRepairSchedulerTask<T>) => void;
  onCompleted?: (task: BatchRepairSchedulerTask<T>, result: R) => void | Promise<void>;
  onFailed?: (task: BatchRepairSchedulerTask<T>, error: unknown) => void | Promise<void>;
}) {
  const maxConcurrency = Math.max(1, Math.min(3, Math.floor(input.maxConcurrency || 3)));
  const queue: Array<BatchRepairSchedulerTask<T>> = [];
  const fingerprints = new Set<string>();
  const idleWaiters = new Set<() => void>();
  let activeCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let closed = false;
  let pumpQueued = false;

  function isIdle() {
    return queue.length === 0 && activeCount === 0;
  }

  function resolveIdleWaiters() {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  async function runTask(task: BatchRepairSchedulerTask<T>) {
    activeCount += 1;
    input.onStarted?.(task);
    try {
      const result = await input.execute(task);
      completedCount += 1;
      await input.onCompleted?.(task, result);
    } catch (error) {
      failedCount += 1;
      await input.onFailed?.(task, error);
    } finally {
      activeCount -= 1;
      schedulePump();
      resolveIdleWaiters();
    }
  }

  function pump() {
    pumpQueued = false;
    if (closed) {
      resolveIdleWaiters();
      return;
    }
    while (activeCount < maxConcurrency && queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      void runTask(task);
    }
    resolveIdleWaiters();
  }

  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(pump);
  }

  function enqueue(task: BatchRepairSchedulerTask<T>) {
    const fingerprint = String(task.fingerprint || "").trim();
    if (closed || !fingerprint || fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    queue.push({ ...task, fingerprint });
    schedulePump();
    return true;
  }

  function waitForIdle() {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  }

  function snapshot(): BatchRepairSchedulerSnapshot {
    return {
      queuedCount: queue.length,
      activeCount,
      completedCount,
      failedCount,
      knownFingerprints: fingerprints.size,
      idle: isIdle(),
    };
  }

  function close() {
    closed = true;
    queue.splice(0);
    resolveIdleWaiters();
  }

  function signal() {
    schedulePump();
  }

  return { enqueue, signal, waitForIdle, snapshot, close };
}

export type LateRepairMergeAction =
  | "continue_polling"
  | "merge"
  | "late_patch_available"
  | "archive_stale"
  | "ignore_duplicate";

export function decideLateRepairMerge(input: {
  jobId: string;
  activeRepairJobId?: string;
  jobStatus: "pending" | "running" | "completed" | "failed";
  expectedContractHash: string;
  currentContractHash?: string;
  expectedResultHash: string;
  currentResultHash?: string;
  mergedJobIds: ReadonlySet<string>;
  saveStatus: "not_ready" | "cached" | "saving" | "saved" | "review_saved" | "save_failed";
}): { action: LateRepairMergeAction; reason: string } {
  if (input.mergedJobIds.has(input.jobId)) {
    return { action: "ignore_duplicate", reason: "repair job was already merged" };
  }
  if (input.activeRepairJobId && input.activeRepairJobId !== input.jobId) {
    return { action: "archive_stale", reason: "another repair job is active" };
  }
  if (input.jobStatus === "pending" || input.jobStatus === "running") {
    return { action: "continue_polling", reason: "repair job is still active" };
  }
  if (
    input.jobStatus === "failed"
    || input.expectedContractHash !== input.currentContractHash
    || input.expectedResultHash !== input.currentResultHash
  ) {
    return { action: "archive_stale", reason: "repair hashes no longer match the current segment" };
  }
  if (input.saveStatus === "saving") {
    return { action: "continue_polling", reason: "segment save is still in flight" };
  }
  if (input.saveStatus === "saved" || input.saveStatus === "review_saved") {
    return { action: "late_patch_available", reason: "segment was already persisted" };
  }
  return { action: "merge", reason: "repair result matches the active segment revision" };
}

export type BatchInvocationMetricName =
  | "renderPackCalls"
  | "singleRegenerationCalls"
  | "pathPatchJobCreated"
  | "pathPatchCompleted"
  | "judgeCalls"
  | "localPatchOperations";

export type BatchInvocationLedgerEvent = {
  name: BatchInvocationMetricName;
  at: number;
  segmentIndex?: number;
  count: number;
  fingerprint?: string;
};

export function createBatchInvocationLedger(initialEvents: readonly BatchInvocationLedgerEvent[] = []) {
  const events: BatchInvocationLedgerEvent[] = initialEvents.map((event) => ({ ...event }));
  function record(
    name: BatchInvocationMetricName,
    input: Omit<BatchInvocationLedgerEvent, "name" | "at" | "count"> & { at?: number; count?: number } = {},
  ) {
    events.push({ name, at: input.at ?? Date.now(), count: input.count || 1, ...input });
  }
  function summary() {
    const counts: Record<BatchInvocationMetricName, number> = {
      renderPackCalls: 0,
      singleRegenerationCalls: 0,
      pathPatchJobCreated: 0,
      pathPatchCompleted: 0,
      judgeCalls: 0,
      localPatchOperations: 0,
    };
    for (const event of events) counts[event.name] += event.count;
    return { ...counts, events: events.map((event) => ({ ...event })) };
  }
  function restore(restoredEvents: readonly BatchInvocationLedgerEvent[]) {
    events.splice(0, events.length, ...restoredEvents.map((event) => ({ ...event })));
  }
  return { record, summary, restore };
}

export const REPAIR_FINAL_OBSERVATION_TIMEOUT_MS = 30 * 60_000;

export function shouldContinueDetachedRepairObservation(input: {
  detachedAt: number;
  now: number;
  finalObservationTimeoutMs?: number;
}) {
  const timeoutMs = Math.max(
    REPAIR_FRONTEND_WAIT_TIMEOUT_MS,
    input.finalObservationTimeoutMs || REPAIR_FINAL_OBSERVATION_TIMEOUT_MS,
  );
  return input.now - input.detachedAt < timeoutMs;
}
