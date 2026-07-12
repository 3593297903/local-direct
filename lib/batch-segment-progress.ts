export type BatchSegmentProgressStatus =
  | "pending"
  | "running"
  | "validating"
  | "adjudicating"
  | "patching"
  | "repairing"
  | "needs_review"
  | "review_saved"
  | "quota_paused"
  | "cached"
  | "completed"
  | "saving"
  | "saved"
  | "failed";

export type BatchSegmentProgressItem = {
  index: number;
  status: BatchSegmentProgressStatus;
};

export type SegmentGenerationStatus =
  | "pending"
  | "rendering"
  | "rendered"
  | "repair_pending"
  | "repair_running"
  | "repair_detached"
  | "settled";

export type SegmentQualityDecisionStatus = "unknown" | "passed" | "needs_review" | "blocked";

export type SegmentSaveStatus =
  | "not_ready"
  | "cached"
  | "saving"
  | "saved"
  | "review_saved"
  | "save_failed";

export type SegmentStateRecord = {
  index: number;
  generationStatus: SegmentGenerationStatus;
  qualityStatus: SegmentQualityDecisionStatus;
  saveStatus: SegmentSaveStatus;
  revision: number;
  activeRepairJobId?: string;
  repairFingerprint?: string;
  contractHash?: string;
  resultHash?: string;
  saveRetryCount: number;
  lastErrorCode?: string;
  message?: string;
  displayStatus?: BatchSegmentProgressStatus;
  latePatchAvailable?: boolean;
  updatedAt: number;
};

type SegmentStateEventBase = { baseRevision?: number; at?: number };

export type SegmentStateEvent = SegmentStateEventBase & (
  | { type: "RENDER_STARTED" }
  | { type: "RENDER_SUCCEEDED"; resultHash: string; contractHash?: string }
  | { type: "QUALITY_PASSED" }
  | { type: "QUALITY_NEEDS_REVIEW"; message?: string }
  | { type: "QUALITY_BLOCKED"; message?: string }
  | { type: "REPAIR_QUEUED"; jobId?: string; fingerprint: string; message?: string }
  | { type: "REPAIR_STARTED"; jobId: string }
  | { type: "REPAIR_DETACHED"; jobId: string; message?: string }
  | { type: "REPAIR_COMPLETED"; jobId: string; resultHash: string }
  | { type: "REPAIR_FAILED"; jobId?: string; errorCode?: string; message?: string }
  | { type: "CACHE_READY" }
  | { type: "SAVE_STARTED" }
  | { type: "SAVE_SUCCEEDED"; review: boolean }
  | { type: "SAVE_FAILED"; errorCode: string; message?: string }
  | { type: "SAVE_RESUMED" }
  | { type: "LATE_PATCH_AVAILABLE"; jobId: string }
  | { type: "PROGRESS_UPDATED"; status: BatchSegmentProgressStatus; message?: string }
  | { type: "MESSAGE_UPDATED"; message?: string }
);

export function createInitialSegmentState(
  index: number,
  input: { contractHash?: string; updatedAt?: number } = {},
): SegmentStateRecord {
  return {
    index,
    generationStatus: "pending",
    qualityStatus: "unknown",
    saveStatus: "not_ready",
    revision: 0,
    contractHash: input.contractHash,
    saveRetryCount: 0,
    updatedAt: input.updatedAt || 0,
  };
}

export function createInitialSegmentStates(
  segmentCount: number,
  contractHashes: ReadonlyMap<number, string> = new Map(),
) {
  return Array.from({ length: Math.max(0, segmentCount) }, (_, index) => (
    createInitialSegmentState(index + 1, { contractHash: contractHashes.get(index + 1) })
  ));
}

function isPersistedSaveStatus(status: SegmentSaveStatus) {
  return status === "saved" || status === "review_saved";
}

export function isLegalSegmentStateEvent(state: SegmentStateRecord, event: SegmentStateEvent) {
  switch (event.type) {
    case "RENDER_STARTED":
      return !isPersistedSaveStatus(state.saveStatus)
        && ["pending", "rendered", "settled"].includes(state.generationStatus);
    case "RENDER_SUCCEEDED":
      return !isPersistedSaveStatus(state.saveStatus)
        && ["pending", "rendering", "rendered"].includes(state.generationStatus);
    case "QUALITY_PASSED":
    case "QUALITY_NEEDS_REVIEW":
    case "QUALITY_BLOCKED":
      return Boolean(state.resultHash)
        && ["rendered", "repair_detached", "settled"].includes(state.generationStatus);
    case "REPAIR_QUEUED":
      return !isPersistedSaveStatus(state.saveStatus)
        && !["repair_pending", "repair_running"].includes(state.generationStatus);
    case "REPAIR_STARTED":
      return state.generationStatus === "repair_pending" || state.generationStatus === "repair_detached";
    case "REPAIR_DETACHED":
      return state.generationStatus === "repair_running"
        && (!state.activeRepairJobId || state.activeRepairJobId === event.jobId);
    case "REPAIR_COMPLETED":
      return ["repair_pending", "repair_running", "repair_detached"].includes(state.generationStatus)
        && Boolean(state.activeRepairJobId)
        && state.activeRepairJobId === event.jobId;
    case "REPAIR_FAILED":
      return ["repair_pending", "repair_running", "repair_detached"].includes(state.generationStatus)
        && (!event.jobId || !state.activeRepairJobId || state.activeRepairJobId === event.jobId);
    case "CACHE_READY":
      return Boolean(state.resultHash)
        && state.qualityStatus !== "unknown"
        && !isPersistedSaveStatus(state.saveStatus);
    case "SAVE_STARTED":
      return state.saveStatus === "cached";
    case "SAVE_SUCCEEDED":
      return Boolean(state.resultHash)
        && state.qualityStatus !== "unknown"
        && (state.saveStatus === "saving" || state.saveStatus === "cached" || state.saveStatus === "not_ready");
    case "SAVE_FAILED":
      return state.saveStatus === "saving";
    case "SAVE_RESUMED":
      return state.saveStatus === "save_failed";
    case "LATE_PATCH_AVAILABLE":
      return isPersistedSaveStatus(state.saveStatus)
        && (!state.activeRepairJobId || state.activeRepairJobId === event.jobId);
    case "PROGRESS_UPDATED":
    case "MESSAGE_UPDATED":
      return true;
  }
}

function reportIllegalSegmentStateEvent(state: SegmentStateRecord, event: SegmentStateEvent) {
  if (process.env.NODE_ENV === "production") return;
  console.warn(
    `[segment-state] ignored illegal ${event.type} for segment ${state.index} at revision ${state.revision}`,
  );
}

export function reduceSegmentState(state: SegmentStateRecord, event: SegmentStateEvent): SegmentStateRecord {
  if (event.baseRevision !== undefined && event.baseRevision !== state.revision) return state;
  if (!isLegalSegmentStateEvent(state, event)) {
    reportIllegalSegmentStateEvent(state, event);
    return state;
  }
  const next: SegmentStateRecord = {
    ...state,
    revision: state.revision + 1,
    updatedAt: event.at ?? Date.now(),
  };
  switch (event.type) {
    case "RENDER_STARTED":
      return { ...next, generationStatus: "rendering", lastErrorCode: undefined };
    case "RENDER_SUCCEEDED":
      return {
        ...next,
        generationStatus: "rendered",
        resultHash: event.resultHash,
        contractHash: event.contractHash || state.contractHash,
        lastErrorCode: undefined,
      };
    case "QUALITY_PASSED":
      return { ...next, qualityStatus: "passed", message: undefined };
    case "QUALITY_NEEDS_REVIEW":
      return { ...next, qualityStatus: "needs_review", message: event.message };
    case "QUALITY_BLOCKED":
      return { ...next, qualityStatus: "blocked", message: event.message };
    case "REPAIR_QUEUED":
      return {
        ...next,
        generationStatus: "repair_pending",
        activeRepairJobId: event.jobId || state.activeRepairJobId,
        repairFingerprint: event.fingerprint,
        message: event.message,
      };
    case "REPAIR_STARTED":
      return { ...next, generationStatus: "repair_running", activeRepairJobId: event.jobId };
    case "REPAIR_DETACHED":
      if (state.activeRepairJobId && state.activeRepairJobId !== event.jobId) return state;
      return { ...next, generationStatus: "repair_detached", activeRepairJobId: event.jobId, message: event.message };
    case "REPAIR_COMPLETED":
      if (state.activeRepairJobId && state.activeRepairJobId !== event.jobId) return state;
      return {
        ...next,
        generationStatus: "rendered",
        qualityStatus: "unknown",
        activeRepairJobId: undefined,
        resultHash: event.resultHash,
        lastErrorCode: undefined,
      };
    case "REPAIR_FAILED":
      if (event.jobId && state.activeRepairJobId && state.activeRepairJobId !== event.jobId) return state;
      return {
        ...next,
        generationStatus: "settled",
        qualityStatus: state.qualityStatus === "passed" ? "passed" : "needs_review",
        activeRepairJobId: undefined,
        lastErrorCode: event.errorCode,
        message: event.message,
      };
    case "CACHE_READY":
      return {
        ...next,
        generationStatus: state.generationStatus === "repair_detached" ? "repair_detached" : "settled",
        saveStatus: "cached",
        lastErrorCode: undefined,
      };
    case "SAVE_STARTED":
      return { ...next, saveStatus: "saving", lastErrorCode: undefined };
    case "SAVE_SUCCEEDED":
      return {
        ...next,
        generationStatus: "settled",
        saveStatus: event.review ? "review_saved" : "saved",
        lastErrorCode: undefined,
      };
    case "SAVE_FAILED":
      return {
        ...next,
        generationStatus: "settled",
        saveStatus: "save_failed",
        saveRetryCount: state.saveRetryCount + 1,
        lastErrorCode: event.errorCode,
        message: event.message,
      };
    case "SAVE_RESUMED":
      return { ...next, saveStatus: "cached", lastErrorCode: undefined, message: undefined };
    case "LATE_PATCH_AVAILABLE":
      return { ...next, latePatchAvailable: true, activeRepairJobId: event.jobId };
    case "PROGRESS_UPDATED":
      return { ...next, displayStatus: event.status, message: event.message };
    case "MESSAGE_UPDATED":
      return { ...next, message: event.message };
  }
}

export function reduceSegmentStates(
  states: SegmentStateRecord[],
  segmentIndex: number,
  event: SegmentStateEvent,
) {
  return states.map((state) => state.index === segmentIndex ? reduceSegmentState(state, event) : state);
}

export function progressStatusFromSegmentState(state: SegmentStateRecord): BatchSegmentProgressStatus {
  if (state.saveStatus === "saved") return "saved";
  if (state.saveStatus === "review_saved") return "review_saved";
  if (state.saveStatus === "saving") return "saving";
  if (state.saveStatus === "save_failed") return "failed";
  if (state.qualityStatus === "needs_review") return "needs_review";
  if (state.generationStatus === "repair_pending" || state.generationStatus === "repair_running") return "repairing";
  if (state.generationStatus === "repair_detached") return "patching";
  if (state.generationStatus === "rendering") return "running";
  if (state.saveStatus === "cached") return "cached";
  if (state.qualityStatus === "blocked") return "failed";
  return state.displayStatus || "pending";
}

export type DerivedBatchPhase = "rendering" | "repairing" | "saving" | "needs_review" | "completed" | "failed";

export function deriveBatchPhaseFromSegmentStates(states: SegmentStateRecord[]): DerivedBatchPhase {
  if (!states.length) return "rendering";
  const allPersisted = states.every((state) => state.saveStatus === "saved" || state.saveStatus === "review_saved");
  if (allPersisted) {
    return states.some((state) => state.saveStatus === "review_saved" || state.qualityStatus === "needs_review")
      ? "needs_review"
      : "completed";
  }
  if (states.some((state) => state.saveStatus === "saving")) return "saving";
  if (states.some((state) => ["repair_pending", "repair_running", "repair_detached"].includes(state.generationStatus))) {
    return "repairing";
  }
  if (states.some((state) => state.saveStatus === "cached" || state.saveStatus === "save_failed")) return "saving";
  if (states.some((state) => state.qualityStatus === "blocked" && state.generationStatus === "settled")) return "failed";
  return "rendering";
}

export type ResumableBatchSaveResult =
  | {
      saved: true;
      projectId: string;
      versionId: string;
      versionNumber: number;
      idempotentReplay?: boolean;
      requestId?: string;
    }
  | {
      saved: false;
      retryable: boolean;
      errorCode: string;
      message: string;
      requestId?: string;
    };

export type ResumableBatchSaveEntry<T> = {
  segmentIndex: number;
  status: "not_ready" | "cached" | "saving" | "saved" | "review_saved" | "save_failed";
  payload?: T;
  review: boolean;
  attempts: number;
  lastResult?: ResumableBatchSaveResult;
};

export function createResumableBatchSaveController<T>(input: {
  durableBatchId: string;
  segmentCount: number;
  saveSegment: (request: {
    segmentIndex: number;
    idempotencyKey: string;
    payload: T;
    review: boolean;
  }) => Promise<ResumableBatchSaveResult>;
  sleep?: (ms: number) => Promise<unknown>;
  onTransition?: (entry: Readonly<ResumableBatchSaveEntry<T>>) => void;
}) {
  const sleep = input.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryDelays = [1_000, 3_000, 8_000] as const;
  const entries = Array.from({ length: input.segmentCount }, (_, offset): ResumableBatchSaveEntry<T> => ({
    segmentIndex: offset + 1,
    status: "not_ready",
    review: false,
    attempts: 0,
  }));
  let activeDrain: Promise<void> | null = null;

  function emit(entry: ResumableBatchSaveEntry<T>) {
    input.onTransition?.({ ...entry });
  }

  function cache(segmentIndex: number, payload: T, options: { review?: boolean } = {}) {
    const entry = entries[segmentIndex - 1];
    if (!entry) throw new Error(`Batch save segment ${segmentIndex} is out of range`);
    if (entry.status === "saved" || entry.status === "review_saved") return;
    entry.payload = payload;
    entry.review = Boolean(options.review);
    if (entry.status === "save_failed") {
      emit(entry);
      return;
    }
    entry.status = "cached";
    entry.lastResult = undefined;
    emit(entry);
  }

  async function saveEntry(entry: ResumableBatchSaveEntry<T>) {
    if (entry.payload === undefined) return false;
    entry.status = "saving";
    emit(entry);
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      entry.attempts += 1;
      const result = await input.saveSegment({
        segmentIndex: entry.segmentIndex,
        idempotencyKey: `${input.durableBatchId}:${entry.segmentIndex}`,
        payload: entry.payload,
        review: entry.review,
      });
      entry.lastResult = result;
      if (result.saved) {
        entry.status = entry.review ? "review_saved" : "saved";
        emit(entry);
        return true;
      }
      if (!result.retryable || attempt >= retryDelays.length) {
        entry.status = "save_failed";
        emit(entry);
        return false;
      }
      await sleep(retryDelays[attempt]);
    }
    return false;
  }

  async function runDrain() {
    for (const entry of entries) {
      if (entry.status === "saved" || entry.status === "review_saved") continue;
      if (entry.status !== "cached" || entry.payload === undefined) break;
      const saved = await saveEntry(entry);
      if (!saved) break;
    }
  }

  function drain() {
    if (activeDrain) return activeDrain;
    activeDrain = runDrain().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  }

  function resume() {
    const failed = entries.find((entry) => entry.status === "save_failed");
    if (failed) {
      failed.status = "cached";
      failed.lastResult = undefined;
      emit(failed);
    }
    return drain();
  }

  function restore(segmentIndex: number, inputState: {
    payload?: T;
    review?: boolean;
    status: ResumableBatchSaveEntry<T>["status"];
    attempts?: number;
    lastResult?: ResumableBatchSaveResult;
  }) {
    const entry = entries[segmentIndex - 1];
    if (!entry) throw new Error(`Batch save segment ${segmentIndex} is out of range`);
    entry.payload = inputState.payload;
    entry.review = Boolean(inputState.review);
    entry.status = inputState.status;
    entry.attempts = inputState.attempts || 0;
    entry.lastResult = inputState.lastResult;
    emit(entry);
  }

  function snapshot() {
    return {
      durableBatchId: input.durableBatchId,
      segments: entries.map((entry) => ({ ...entry })),
      draining: Boolean(activeDrain),
    };
  }

  return { cache, drain, resume, restore, snapshot };
}

export function collectContiguousBatchSaveIndexes(input: {
  startIndex: number;
  segmentCount: number;
  renderedIndexes: ReadonlySet<number>;
  queuedIndexes: ReadonlySet<number>;
  savedIndexes: ReadonlySet<number>;
}) {
  const indexes: number[] = [];
  for (let index = Math.max(1, input.startIndex); index <= input.segmentCount; index += 1) {
    if (input.savedIndexes.has(index) || input.queuedIndexes.has(index)) continue;
    if (!input.renderedIndexes.has(index)) break;
    indexes.push(index);
  }
  return indexes;
}

export function summarizeBatchSegmentProgress(
  items: BatchSegmentProgressItem[],
  resolvedSegmentCount: number | null,
) {
  const count = (statuses: BatchSegmentProgressStatus[]) => items.filter((item) => statuses.includes(item.status)).length;
  const savedCount = count(["saved", "completed", "review_saved"]);
  const cachedCount = count(["cached"]);
  const runningCount = count(["running"]);
  const repairingCount = count(["repairing"]);
  const adjudicatingCount = count(["adjudicating", "validating", "patching"]);
  const needsReviewCount = count(["needs_review", "review_saved"]);
  const savingCount = count(["saving"]);
  const pendingCount = count(["pending"]);
  const failedCount = count(["failed"]);
  const quotaPausedCount = count(["quota_paused"]);
  const isSettled = Boolean(resolvedSegmentCount)
    && savedCount >= Number(resolvedSegmentCount)
    && runningCount === 0
    && repairingCount === 0
    && adjudicatingCount === 0
    && savingCount === 0
    && pendingCount === 0
    && failedCount === 0
    && quotaPausedCount === 0;
  return {
    savedCount,
    cachedCount,
    runningCount,
    repairingCount,
    adjudicatingCount,
    needsReviewCount,
    savingCount,
    pendingCount,
    failedCount,
    quotaPausedCount,
    isSettled,
    terminalPhase: isSettled ? (needsReviewCount > 0 ? "needs_review" as const : "completed" as const) : null,
  };
}

export function resolveBatchGenerationPhase<T extends string>(
  requestedPhase: T,
  summary: ReturnType<typeof summarizeBatchSegmentProgress>,
) {
  if (summary.isSettled) return summary.terminalPhase || requestedPhase;
  return requestedPhase === "needs_review" ? "rendering" : requestedPhase;
}
