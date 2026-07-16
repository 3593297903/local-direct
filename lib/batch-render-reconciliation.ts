import type { RenderOperationRefV2 } from "./batch-render-operation";

export type RenderReconciliationCurrentSegment = {
  operationToken?: string;
  sourceHash?: string;
  contractHash?: string;
  resultHash?: string;
};

export type CompletedRenderPackForReconciliation = {
  id: string;
  protocolVersion?: number;
  status: string;
  stage?: string;
  resultAvailable?: boolean;
  batchId?: string;
  operationToken?: string;
  sourceHash?: string;
  aggregateContractHash?: string;
  segmentIndexes?: number[];
  contractHashes?: Record<string, string>;
  resultHash?: string;
  result?: {
    segments?: Array<{
      episodeIndex: number;
      resultHash?: string;
      result?: unknown;
      coverageSidecar?: unknown;
    }>;
  } | null;
};

export type ReconcileRenderResult =
  | { status: "waiting"; stage: string }
  | { status: "merged" | "replay"; segmentIndexes: number[]; resultHashes: Record<string, string> }
  | { status: "ignored"; reasonCode: string; segmentIndexes: number[] }
  | { status: "failed"; errorCode: string; retryable: boolean };

type IndexedReconciliationValue = { episodeIndex: number };
type IndexedReconciliationResult = IndexedReconciliationValue & {
  resultHash?: string;
  result?: unknown;
};

export type PreparedRenderPackReconciliation<TAction> = {
  segmentIndexes: number[];
  actions: Array<{ segmentIndex: number; action: TAction }>;
  resultHashes: Record<string, string>;
};

const ACTIVE_RENDER_OPERATION_STATES = new Set(["creating", "observing", "detached"]);

export function listRecoverableRenderOperations(operations: RenderOperationRefV2[]) {
  const byJobId = new Map<string, RenderOperationRefV2>();
  for (const operation of operations) {
    if (!ACTIVE_RENDER_OPERATION_STATES.has(operation.state) || !operation.jobId) continue;
    const current = byJobId.get(operation.jobId);
    if (!current || Date.parse(operation.createdAt) >= Date.parse(current.createdAt)) {
      byJobId.set(operation.jobId, operation);
    }
  }
  return [...byJobId.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export function createRenderPackObserverRegistry<T = unknown>() {
  const observers = new Map<string, Promise<T>>();
  return {
    observe(jobId: string, factory: () => Promise<T>) {
      const active = observers.get(jobId);
      if (active) return active;
      const observer = Promise.resolve().then(factory).finally(() => {
        if (observers.get(jobId) === observer) observers.delete(jobId);
      });
      observers.set(jobId, observer);
      return observer;
    },
    has(jobId: string) {
      return observers.has(jobId);
    },
    size() {
      return observers.size;
    },
  };
}

export function shouldRetainRenderRecoveryPointer(input: {
  operations: RenderOperationRefV2[];
  segmentStates: Array<{ generationStatus?: string; saveStatus?: string }>;
}) {
  if (input.operations.some((operation) => ACTIVE_RENDER_OPERATION_STATES.has(operation.state))) return true;
  return input.segmentStates.some((state) => (
    state.saveStatus !== "saved" && state.saveStatus !== "review_saved"
  ));
}

export function reconcileDetachedRenderPack(input: {
  operation: RenderOperationRefV2;
  job: CompletedRenderPackForReconciliation;
  manifestValidated: boolean;
  currentSegments: Record<string, RenderReconciliationCurrentSegment>;
}): ReconcileRenderResult {
  const { operation, job, currentSegments } = input;
  if (job.status !== "completed") {
    if (job.status === "failed") {
      return failed("RENDER_RECONCILIATION_JOB_FAILED", false);
    }
    return { status: "waiting", stage: String(job.stage || job.status || "pending") };
  }

  if (
    !input.manifestValidated
    || job.protocolVersion !== 2
    || job.resultAvailable !== true
    || !job.result
    || !requiredIdentity(job.resultHash)
  ) {
    return failed("RENDER_RECONCILIATION_MANIFEST_INVALID", false);
  }

  if (
    job.id !== operation.jobId
    || job.batchId !== operation.batchId
    || job.operationToken !== operation.operationToken
    || job.sourceHash !== operation.sourceHash
    || job.aggregateContractHash !== operation.aggregateContractHash
  ) {
    return failed("RENDER_RECONCILIATION_OPERATION_IDENTITY_INVALID", false);
  }

  if (!sameOrderedUniqueIndexes(job.segmentIndexes, operation.segmentIndexes)) {
    return failed("RENDER_RECONCILIATION_SEGMENT_IDENTITY_INVALID", false);
  }
  if (!sameHashes(job.contractHashes, operation.contractHashes, operation.segmentIndexes)) {
    return failed("RENDER_RECONCILIATION_CONTRACT_IDENTITY_INVALID", false);
  }

  const resultSegments = job.result.segments;
  const resultIndexes = resultSegments?.map((segment) => Number(segment.episodeIndex));
  if (!resultSegments || !sameOrderedUniqueIndexes(resultIndexes, operation.segmentIndexes)) {
    return failed("RENDER_RECONCILIATION_SEGMENT_IDENTITY_INVALID", false);
  }
  const resultHashes: Record<string, string> = {};
  for (const segment of resultSegments) {
    if (!requiredIdentity(segment.resultHash) || !segment.result) {
      return failed("RENDER_RECONCILIATION_RESULT_INVALID", false);
    }
    resultHashes[String(segment.episodeIndex)] = segment.resultHash!;
  }

  if (operation.state === "merged") {
    if (
      operation.finalManifestHash === job.resultHash
      && sameHashes(operation.resultHashes, resultHashes, operation.segmentIndexes)
    ) {
      return { status: "replay", segmentIndexes: [...operation.segmentIndexes], resultHashes };
    }
    return failed("RENDER_RECONCILIATION_IMMUTABLE_RESULT_CONFLICT", false);
  }
  if (operation.state === "ignored" || operation.state === "failed") {
    return {
      status: "ignored",
      reasonCode: "RENDER_RECONCILIATION_OPERATION_TERMINAL",
      segmentIndexes: [...operation.segmentIndexes],
    };
  }

  const staleIndexes: number[] = [];
  for (const segmentIndex of operation.segmentIndexes) {
    const current = currentSegments[String(segmentIndex)];
    if (
      !current
      || current.operationToken !== operation.operationToken
      || current.sourceHash !== operation.sourceHash
      || current.contractHash !== operation.contractHashes[String(segmentIndex)]
    ) {
      staleIndexes.push(segmentIndex);
    }
  }
  if (staleIndexes.length) {
    return {
      status: "ignored",
      reasonCode: "RENDER_RECONCILIATION_STALE_OPERATION",
      segmentIndexes: staleIndexes,
    };
  }

  const alreadyAccepted = operation.segmentIndexes.filter((segmentIndex) => (
    currentSegments[String(segmentIndex)]?.resultHash === resultHashes[String(segmentIndex)]
  ));
  if (alreadyAccepted.length === operation.segmentIndexes.length) {
    return { status: "replay", segmentIndexes: [...operation.segmentIndexes], resultHashes };
  }

  return {
    status: "merged",
    segmentIndexes: operation.segmentIndexes.filter((segmentIndex) => !alreadyAccepted.includes(segmentIndex)),
    resultHashes,
  };
}

export function prepareRenderPackReconciliation<
  TContext extends IndexedReconciliationValue,
  TResult extends IndexedReconciliationResult,
  TAction,
>(input: {
  operation: RenderOperationRefV2;
  eligibleSegmentIndexes: number[];
  contexts: TContext[];
  results: TResult[];
  prepareSegment: (input: {
    segmentIndex: number;
    context: TContext;
    result: TResult;
    resultHash: string;
  }) => TAction;
}): PreparedRenderPackReconciliation<TAction> {
  const expectedIndexes = [...input.operation.segmentIndexes];
  const contextByIndex = exactReconciliationMap(input.contexts, expectedIndexes, "context");
  const resultByIndex = exactReconciliationMap(input.results, expectedIndexes, "result");
  const eligibleSegmentIndexes = normalizeEligibleReconciliationIndexes(
    input.eligibleSegmentIndexes,
    expectedIndexes,
  );
  const resultHashes: Record<string, string> = {};

  for (const segmentIndex of expectedIndexes) {
    const result = resultByIndex.get(segmentIndex)!;
    if (!requiredIdentity(result.resultHash) || result.result === undefined || result.result === null) {
      throw new Error(`Render reconciliation result ${segmentIndex} is incomplete`);
    }
    resultHashes[String(segmentIndex)] = result.resultHash;
  }

  const actions = eligibleSegmentIndexes.map((segmentIndex) => {
    const result = resultByIndex.get(segmentIndex)!;
    return {
      segmentIndex,
      action: input.prepareSegment({
        segmentIndex,
        context: contextByIndex.get(segmentIndex)!,
        result,
        resultHash: result.resultHash!,
      }),
    };
  });

  return { segmentIndexes: eligibleSegmentIndexes, actions, resultHashes };
}

export async function applyPreparedRenderPackReconciliation<TAction>(
  prepared: PreparedRenderPackReconciliation<TAction>,
  input: {
    applySegment: (action: TAction, segmentIndex: number) => void | Promise<void>;
    finalize: (prepared: PreparedRenderPackReconciliation<TAction>) => void | Promise<void>;
  },
) {
  for (const item of prepared.actions) {
    await input.applySegment(item.action, item.segmentIndex);
  }
  await input.finalize(prepared);
}

function exactReconciliationMap<T extends IndexedReconciliationValue>(
  values: T[],
  expectedIndexes: number[],
  label: string,
) {
  const actualIndexes = Array.isArray(values) ? values.map((value) => Number(value?.episodeIndex)) : [];
  if (!sameOrderedUniqueIndexes(actualIndexes, expectedIndexes)) {
    throw new Error(`Render reconciliation ${label} indexes do not match the operation`);
  }
  return new Map(values.map((value) => [Number(value.episodeIndex), value]));
}

function normalizeEligibleReconciliationIndexes(values: number[], expectedIndexes: number[]) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error("Render reconciliation eligible indexes are invalid");
  }
  const expected = new Set(expectedIndexes);
  if (
    values.some((value) => !Number.isInteger(value) || !expected.has(value))
    || values.some((value, index) => index > 0 && values[index - 1] >= value)
  ) {
    throw new Error("Render reconciliation eligible indexes are invalid");
  }
  return [...values];
}

function sameOrderedUniqueIndexes(actual: number[] | undefined, expected: number[]) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  if (new Set(actual).size !== actual.length) return false;
  return actual.every((value, index) => Number.isInteger(value) && value === expected[index]);
}

function sameHashes(
  actual: Record<string, string> | undefined,
  expected: Record<string, string> | undefined,
  indexes: number[],
) {
  if (!actual || !expected) return false;
  const expectedKeys = indexes.map(String);
  const actualKeys = Object.keys(actual).sort((left, right) => Number(left) - Number(right));
  const referenceKeys = Object.keys(expected).sort((left, right) => Number(left) - Number(right));
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && JSON.stringify(referenceKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => requiredIdentity(actual[key]) && actual[key] === expected[key]);
}

function requiredIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function failed(errorCode: string, retryable: boolean): ReconcileRenderResult {
  return { status: "failed", errorCode, retryable };
}
