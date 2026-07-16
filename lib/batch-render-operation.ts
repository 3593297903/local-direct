import { createHash, randomUUID } from "node:crypto";
import type { SegmentContract } from "./batch-segment-contract";
import { hashCanonicalJson } from "./codex-job-finalization";

export type RenderOperationState =
  | "creating"
  | "observing"
  | "detached"
  | "merged"
  | "ignored"
  | "failed";

export type RenderOperationReconciliationContext = {
  sourceText: string;
  segments: Array<{
    episodeIndex: number;
    title: string;
    sourceText: string;
    duration: string;
    shotCount?: number;
    segmentContract?: SegmentContract;
  }>;
};

export type RenderOperationRefV2 = {
  protocolVersion: 2;
  operationToken: string;
  idempotencyKey: string;
  jobId?: string;
  batchId: string;
  segmentIndexes: number[];
  sourceHash?: string;
  aggregateContractHash: string;
  contractHashes: Record<string, string>;
  createdAt: string;
  state: RenderOperationState;
  detachedAt?: string;
  mergedAt?: string;
  finalManifestHash?: string;
  resultHashes?: Record<string, string>;
  ignoreReasonCode?: string;
  lastErrorCode?: string;
  reconciliationContext?: RenderOperationReconciliationContext;
};

export type CreateRenderOperationInput = {
  batchId: string;
  operationToken?: string;
  segmentIndexes: number[];
  sourceHash?: string;
  contractHashes: Record<string, string>;
  reconciliationContext?: RenderOperationReconciliationContext;
  now?: string;
};

const TERMINAL_STATES = new Set<RenderOperationState>(["merged", "ignored", "failed"]);
const MAX_TERMINAL_AUDITS = 100;
const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function createRenderOperationDraft(input: CreateRenderOperationInput): RenderOperationRefV2 {
  const batchId = requiredIdentity(input.batchId, "batchId", 240);
  const operationToken = requiredIdentity(
    input.operationToken || `render-${randomUUID()}`,
    "operationToken",
    240,
  );
  const segmentIndexes = normalizeSegmentIndexes(input.segmentIndexes);
  const contractHashes = normalizeContractHashes(input.contractHashes, segmentIndexes);
  const aggregateContractHash = buildAggregateContractHash(segmentIndexes, contractHashes);
  const createdAt = validTimestamp(input.now || new Date().toISOString(), "createdAt");
  const draft = {
    protocolVersion: 2 as const,
    operationToken,
    idempotencyKey: "",
    batchId,
    segmentIndexes,
    ...(input.sourceHash ? { sourceHash: requiredHash(input.sourceHash, "sourceHash") } : {}),
    aggregateContractHash,
    contractHashes,
    createdAt,
    state: "creating" as const,
    ...(input.reconciliationContext
      ? { reconciliationContext: normalizeReconciliationContext(input.reconciliationContext, segmentIndexes) }
      : {}),
  };
  return { ...draft, idempotencyKey: buildRenderOperationIdempotencyKey(draft) };
}

export function buildRenderOperationIdempotencyKey(
  operation: Pick<RenderOperationRefV2, "batchId" | "operationToken" | "segmentIndexes" | "contractHashes">,
) {
  const batchId = requiredIdentity(operation.batchId, "batchId", 240);
  const operationToken = requiredIdentity(operation.operationToken, "operationToken", 240);
  const segmentIndexes = normalizeSegmentIndexes(operation.segmentIndexes);
  const contractHashes = normalizeContractHashes(operation.contractHashes, segmentIndexes);
  const identity = JSON.stringify({
    batchId,
    segmentIndexes,
    operationToken,
    contractHashes: segmentIndexes.map((index) => [String(index), contractHashes[String(index)]]),
  });
  return `render-operation:${createHash("sha256").update(identity).digest("hex")}`;
}

export function attachRenderOperationJob(
  operation: RenderOperationRefV2,
  input: { jobId: string; sourceHash: string; aggregateContractHash: string | null },
): RenderOperationRefV2 {
  const normalized = validateRenderOperation(operation);
  const jobId = requiredIdentity(input.jobId, "jobId", 240);
  const sourceHash = requiredHash(input.sourceHash, "sourceHash");
  const aggregateContractHash = requiredHash(input.aggregateContractHash, "aggregateContractHash");
  if (aggregateContractHash !== normalized.aggregateContractHash) {
    throw new Error("Render operation aggregateContractHash does not match the queue response");
  }
  if (normalized.jobId && normalized.jobId !== jobId) {
    throw new Error("Render operation already references a different jobId");
  }
  return { ...normalized, jobId, sourceHash, aggregateContractHash, state: "observing" };
}

export function detachRenderOperation(
  operation: RenderOperationRefV2,
  input: { at?: string; errorCode?: string } = {},
): RenderOperationRefV2 {
  const normalized = validateRenderOperation(operation);
  if (!normalized.jobId) throw new Error("Render operation cannot detach before queue creation");
  if (TERMINAL_STATES.has(normalized.state)) return normalized;
  return {
    ...normalized,
    state: "detached",
    detachedAt: validTimestamp(input.at || new Date().toISOString(), "detachedAt"),
    ...(input.errorCode ? { lastErrorCode: requiredIdentity(input.errorCode, "lastErrorCode", 160) } : {}),
  };
}

export function terminateRenderOperation(
  operation: RenderOperationRefV2,
  input:
    | { state: "merged"; at?: string; finalManifestHash: string; resultHashes: Record<string, string> }
    | { state: "ignored"; at?: string; reasonCode: string }
    | { state: "failed"; at?: string; errorCode: string },
): RenderOperationRefV2 {
  const normalized = validateRenderOperation(operation);
  const at = validTimestamp(input.at || new Date().toISOString(), "terminalAt");
  const base: RenderOperationRefV2 = {
    ...normalized,
    state: input.state,
    reconciliationContext: undefined,
  };
  if (input.state === "merged") {
    return {
      ...base,
      mergedAt: at,
      finalManifestHash: requiredHash(input.finalManifestHash, "finalManifestHash"),
      resultHashes: normalizeResultHashes(input.resultHashes, normalized.segmentIndexes),
    };
  }
  if (input.state === "ignored") {
    return { ...base, ignoreReasonCode: requiredIdentity(input.reasonCode, "ignoreReasonCode", 160) };
  }
  return { ...base, lastErrorCode: requiredIdentity(input.errorCode, "lastErrorCode", 160) };
}

export function retainBoundedRenderOperationAudits(
  operations: RenderOperationRefV2[],
  maxTerminalAudits = MAX_TERMINAL_AUDITS,
) {
  const normalized = operations.map(validateRenderOperation);
  const active = normalized.filter((operation) => !TERMINAL_STATES.has(operation.state));
  const terminal = normalized
    .filter((operation) => TERMINAL_STATES.has(operation.state))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-Math.max(0, maxTerminalAudits))
    .map((operation) => ({ ...operation, reconciliationContext: undefined }));
  return [...active, ...terminal];
}

export function validateRenderOperation(value: RenderOperationRefV2): RenderOperationRefV2 {
  if (!value || typeof value !== "object" || value.protocolVersion !== 2) {
    throw new Error("Render operation protocolVersion is invalid");
  }
  const batchId = requiredIdentity(value.batchId, "batchId", 240);
  const operationToken = requiredIdentity(value.operationToken, "operationToken", 240);
  const segmentIndexes = normalizeSegmentIndexes(value.segmentIndexes);
  const contractHashes = normalizeContractHashes(value.contractHashes, segmentIndexes);
  const aggregateContractHash = requiredHash(value.aggregateContractHash, "aggregateContractHash");
  if (aggregateContractHash !== buildAggregateContractHash(segmentIndexes, contractHashes)) {
    throw new Error("Render operation aggregateContractHash is invalid");
  }
  const expectedIdempotencyKey = buildRenderOperationIdempotencyKey({
    batchId,
    operationToken,
    segmentIndexes,
    contractHashes,
  });
  if (value.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("Render operation idempotencyKey is invalid");
  }
  if (!["creating", "observing", "detached", "merged", "ignored", "failed"].includes(value.state)) {
    throw new Error("Render operation state is invalid");
  }
  return {
    ...value,
    batchId,
    operationToken,
    segmentIndexes,
    contractHashes,
    aggregateContractHash,
    createdAt: validTimestamp(value.createdAt, "createdAt"),
    ...(value.jobId ? { jobId: requiredIdentity(value.jobId, "jobId", 240) } : {}),
    ...(value.sourceHash ? { sourceHash: requiredHash(value.sourceHash, "sourceHash") } : {}),
    ...(value.reconciliationContext
      ? { reconciliationContext: normalizeReconciliationContext(value.reconciliationContext, segmentIndexes) }
      : {}),
  };
}

function buildAggregateContractHash(indexes: number[], hashes: Record<string, string>) {
  return hashCanonicalJson(indexes.map((episodeIndex) => ({
    episodeIndex,
    contractHash: hashes[String(episodeIndex)],
  })));
}

function normalizeSegmentIndexes(values: number[]) {
  if (!Array.isArray(values) || !values.length) throw new Error("Render operation segmentIndexes are invalid");
  const indexes = values.map(Number).sort((left, right) => left - right);
  if (indexes.some((value) => !Number.isInteger(value) || value < 1) || new Set(indexes).size !== indexes.length) {
    throw new Error("Render operation segmentIndexes are invalid");
  }
  return indexes;
}

function normalizeContractHashes(value: Record<string, string>, indexes: number[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Render operation contractHashes are invalid");
  }
  const expectedKeys = indexes.map(String);
  const actualKeys = Object.keys(value).sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error("Render operation contractHashes do not match segmentIndexes");
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, requiredHash(value[key], `contractHashes.${key}`)]));
}

function normalizeResultHashes(value: Record<string, string>, indexes: number[]) {
  return normalizeContractHashes(value, indexes);
}

function normalizeReconciliationContext(
  value: RenderOperationReconciliationContext,
  indexes: number[],
): RenderOperationReconciliationContext {
  if (!value || typeof value !== "object" || !Array.isArray(value.segments)) {
    throw new Error("Render operation reconciliationContext is invalid");
  }
  const allowed = new Set(indexes);
  const segments = value.segments.map((segment) => {
    if (!allowed.has(segment.episodeIndex)) throw new Error("Render operation reconciliationContext segment is invalid");
    return {
      ...segment,
      episodeIndex: Number(segment.episodeIndex),
      title: requiredText(segment.title, "reconciliationContext.title"),
      sourceText: requiredText(segment.sourceText, "reconciliationContext.sourceText"),
      duration: requiredText(segment.duration, "reconciliationContext.duration"),
    };
  });
  return { sourceText: requiredText(value.sourceText, "reconciliationContext.sourceText"), segments };
}

function requiredIdentity(value: unknown, field: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !IDENTITY_PATTERN.test(text)) {
    throw new Error(`Render operation ${field} is invalid`);
  }
  return text;
}

function requiredHash(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!text || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new Error(`Render operation ${field} is invalid`);
  }
  return text;
}

function requiredText(value: unknown, field: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Render operation ${field} is invalid`);
  return text;
}

function validTimestamp(value: unknown, field: string) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Render operation ${field} is invalid`);
  return text;
}
