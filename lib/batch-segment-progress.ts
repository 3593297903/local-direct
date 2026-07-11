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
