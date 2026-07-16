import type { SegmentContract } from "./batch-segment-contract";
import {
  CONTRACT_PROMPT_COMPILER_VERSION,
  compileSegmentContractForPrompt,
  type CompiledSegmentContractBlock,
} from "./codex-prompt-input-compiler";
import type { PreflightedRenderPack } from "./batch-contract-preflight";

type SuccessfulCompiledSegmentContractBlock = Extract<
  CompiledSegmentContractBlock,
  { status: "ready" | "compacted" }
>;

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

export type RenderOperationCreationContext = {
  compilerVersion: typeof CONTRACT_PROMPT_COMPILER_VERSION;
  segments: Array<{
    episodeIndex: number;
    sourceHash: string;
    contractHash: string;
    compiledContract: SuccessfulCompiledSegmentContractBlock;
    compiledDigest: string;
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
  creationDigest?: string;
  creationContext?: RenderOperationCreationContext;
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
  creationDigest?: string;
  creationContext?: RenderOperationCreationContext;
  reconciliationContext?: RenderOperationReconciliationContext;
  now?: string;
};

const TERMINAL_STATES = new Set<RenderOperationState>(["merged", "ignored", "failed"]);
const MAX_TERMINAL_AUDITS = 100;
const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function createRenderOperationDraft(input: CreateRenderOperationInput): RenderOperationRefV2 {
  const batchId = requiredIdentity(input.batchId, "batchId", 240);
  const operationToken = requiredIdentity(
    input.operationToken || createRenderOperationToken(),
    "operationToken",
    240,
  );
  const segmentIndexes = normalizeSegmentIndexes(input.segmentIndexes);
  const contractHashes = normalizeContractHashes(input.contractHashes, segmentIndexes);
  const aggregateContractHash = buildAggregateContractHash(segmentIndexes, contractHashes);
  const createdAt = validTimestamp(input.now || new Date().toISOString(), "createdAt");
  const reconciliationContext = input.reconciliationContext
    ? normalizeReconciliationContext(input.reconciliationContext, segmentIndexes)
    : undefined;
  const creationContext = input.creationContext
    ? normalizeCreationContext(input.creationContext, segmentIndexes, contractHashes, reconciliationContext)
    : undefined;
  const computedCreationDigest = creationContext ? buildCreationDigest(creationContext) : undefined;
  const creationDigest = input.creationDigest
    ? requiredHash(input.creationDigest, "creationDigest")
    : computedCreationDigest;
  if (creationContext && creationDigest !== computedCreationDigest) {
    throw new Error("Render operation creationDigest does not match creationContext");
  }
  const draft = {
    protocolVersion: 2 as const,
    operationToken,
    idempotencyKey: "",
    batchId,
    segmentIndexes,
    ...(input.sourceHash ? { sourceHash: requiredHash(input.sourceHash, "sourceHash") } : {}),
    aggregateContractHash,
    contractHashes,
    ...(creationDigest ? { creationDigest } : {}),
    ...(creationContext ? { creationContext } : {}),
    createdAt,
    state: "creating" as const,
    ...(reconciliationContext ? { reconciliationContext } : {}),
  };
  return { ...draft, idempotencyKey: buildRenderOperationIdempotencyKey(draft) };
}

export function createRenderOperationDraftFromPreflightPack<T>(input: {
  batchId: string;
  operationToken?: string;
  sourceHash?: string;
  pack: PreflightedRenderPack<T>;
  reconciliationContext: RenderOperationReconciliationContext;
  now?: string;
}) {
  if (!input.pack || input.pack.kind !== "render_pack" || !input.pack.entries.length) {
    throw new Error("Render operation preflight pack is invalid");
  }
  const segments = input.pack.entries.map((entry) => {
    const compiledContract = entry.preflight.compile;
    if (compiledContract.status !== "ready" && compiledContract.status !== "compacted") {
      throw new Error("Render operation preflight pack contains a non-renderable contract");
    }
    if (entry.preflight.disposition === "invalid") {
      throw new Error("Render operation preflight pack contains an invalid disposition");
    }
    return {
      episodeIndex: entry.preflight.segmentIndex,
      sourceHash: entry.preflight.sourceHash,
      contractHash: entry.preflight.contractHash,
      compiledContract,
      compiledDigest: buildCompiledContractDigest(compiledContract),
    };
  });
  const segmentIndexes = segments.map((segment) => segment.episodeIndex);
  const contractHashes = Object.fromEntries(
    segments.map((segment) => [String(segment.episodeIndex), segment.contractHash]),
  );
  const creationContext: RenderOperationCreationContext = {
    compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
    segments,
  };
  return createRenderOperationDraft({
    batchId: input.batchId,
    operationToken: input.operationToken,
    segmentIndexes,
    sourceHash: input.sourceHash,
    contractHashes,
    creationContext,
    creationDigest: buildCreationDigest(creationContext),
    reconciliationContext: input.reconciliationContext,
    now: input.now,
  });
}

export function buildRenderOperationIdempotencyKey(
  operation: Pick<
    RenderOperationRefV2,
    "batchId" | "operationToken" | "segmentIndexes" | "contractHashes" | "creationDigest"
  >,
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
    creationDigest: operation.creationDigest || null,
  });
  return `render-operation:${sha256TextPortable(identity)}`;
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
  return {
    ...normalized,
    jobId,
    sourceHash,
    aggregateContractHash,
    state: "observing",
    creationContext: undefined,
  };
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
    creationContext: undefined,
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
    creationDigest: value.creationDigest,
  });
  if (value.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("Render operation idempotencyKey is invalid");
  }
  if (!["creating", "observing", "detached", "merged", "ignored", "failed"].includes(value.state)) {
    throw new Error("Render operation state is invalid");
  }
  const reconciliationContext = value.reconciliationContext
    ? normalizeReconciliationContext(value.reconciliationContext, segmentIndexes)
    : undefined;
  const creationDigest = value.creationDigest
    ? requiredHash(value.creationDigest, "creationDigest")
    : undefined;
  const creationContext = value.creationContext
    ? normalizeCreationContext(value.creationContext, segmentIndexes, contractHashes, reconciliationContext)
    : undefined;
  if (creationContext && !creationDigest) {
    throw new Error("Render operation creationContext is missing creationDigest");
  }
  if (creationContext && buildCreationDigest(creationContext) !== creationDigest) {
    throw new Error("Render operation creationContext does not match creationDigest");
  }
  if (value.state === "creating" && creationDigest && !creationContext) {
    throw new Error("Render operation creating state is missing creationContext");
  }
  return {
    ...value,
    batchId,
    operationToken,
    segmentIndexes,
    contractHashes,
    aggregateContractHash,
    ...(creationDigest ? { creationDigest } : {}),
    ...(creationContext ? { creationContext } : {}),
    createdAt: validTimestamp(value.createdAt, "createdAt"),
    ...(value.jobId ? { jobId: requiredIdentity(value.jobId, "jobId", 240) } : {}),
    ...(value.sourceHash ? { sourceHash: requiredHash(value.sourceHash, "sourceHash") } : {}),
    ...(reconciliationContext ? { reconciliationContext } : {}),
  };
}

function normalizeCreationContext(
  value: RenderOperationCreationContext,
  indexes: number[],
  contractHashes: Record<string, string>,
  reconciliationContext?: RenderOperationReconciliationContext,
): RenderOperationCreationContext {
  if (
    !value
    || typeof value !== "object"
    || value.compilerVersion !== CONTRACT_PROMPT_COMPILER_VERSION
    || !Array.isArray(value.segments)
    || value.segments.length !== indexes.length
  ) {
    throw new Error("Render operation creationContext is invalid");
  }
  if (!reconciliationContext) {
    throw new Error("Render operation creationContext requires reconciliationContext");
  }

  const normalizedSegments = value.segments.map((segment, offset) => {
    const episodeIndex = Number(segment?.episodeIndex);
    if (episodeIndex !== indexes[offset]) {
      throw new Error("Render operation creationContext segments do not match segmentIndexes");
    }
    const sourceHash = requiredHash(segment.sourceHash, "creationContext.sourceHash");
    const contractHash = requiredHash(segment.contractHash, "creationContext.contractHash");
    if (contractHash !== contractHashes[String(episodeIndex)]) {
      throw new Error("Render operation creationContext contractHash is invalid");
    }
    const compiledContract = segment.compiledContract;
    if (
      !compiledContract
      || (compiledContract.status !== "ready" && compiledContract.status !== "compacted")
      || compiledContract.compilerVersion !== CONTRACT_PROMPT_COMPILER_VERSION
      || compiledContract.segmentIndex !== episodeIndex
      || compiledContract.contractHash !== contractHash
      || new TextEncoder().encode(compiledContract.text).byteLength !== compiledContract.byteLength
      || compiledContract.byteLength > compiledContract.maxBytes
    ) {
      throw new Error("Render operation creationContext compiled contract is invalid");
    }
    const compiledDigest = requiredHash(segment.compiledDigest, "creationContext.compiledDigest");
    if (compiledDigest !== buildCompiledContractDigest(compiledContract)) {
      throw new Error("Render operation creationContext compiled digest is invalid");
    }

    const rawContract = reconciliationContext.segments[offset]?.segmentContract;
    if (!rawContract || rawContract.sourceHash !== sourceHash || rawContract.contractHash !== contractHash) {
      throw new Error("Render operation creationContext does not match reconciliation contract identity");
    }
    const authoritative = compileSegmentContractForPrompt(rawContract, { maxBytes: compiledContract.maxBytes });
    if (
      authoritative.status !== "ready"
      && authoritative.status !== "compacted"
    ) {
      throw new Error("Render operation creationContext reconciliation contract is not renderable");
    }
    if (canonicalJson(authoritative) !== canonicalJson(compiledContract)) {
      throw new Error("Render operation creationContext compiled contract was altered");
    }
    return {
      episodeIndex,
      sourceHash,
      contractHash,
      compiledContract,
      compiledDigest,
    };
  });

  return {
    compilerVersion: CONTRACT_PROMPT_COMPILER_VERSION,
    segments: normalizedSegments,
  };
}

function buildCompiledContractDigest(contract: SuccessfulCompiledSegmentContractBlock) {
  return sha256TextPortable(canonicalJson(contract));
}

function buildCreationDigest(context: RenderOperationCreationContext) {
  return sha256TextPortable(canonicalJson({
    compilerVersion: context.compilerVersion,
    segments: context.segments.map((segment) => ({
      episodeIndex: segment.episodeIndex,
      sourceHash: segment.sourceHash,
      contractHash: segment.contractHash,
      compiledDigest: segment.compiledDigest,
    })),
  }));
}

function canonicalJson(value: unknown) {
  return JSON.stringify(sortCanonicalValue(value));
}

function buildAggregateContractHash(indexes: number[], hashes: Record<string, string>) {
  return hashCanonicalJsonPortable(indexes.map((episodeIndex) => ({
    episodeIndex,
    contractHash: hashes[String(episodeIndex)],
  })));
}

function createRenderOperationToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `render-${globalThis.crypto.randomUUID()}`;
  }
  return `render-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function hashCanonicalJsonPortable(value: unknown) {
  return sha256TextPortable(JSON.stringify(sortCanonicalValue(value)));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortCanonicalValue(nested)]),
  );
}

function rotateRight(value: number, shift: number) {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256TextPortable(text: string) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + upperSigma1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
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
  const contextIndexes = value.segments.map((segment) => Number(segment?.episodeIndex));
  if (
    contextIndexes.length !== indexes.length
    || new Set(contextIndexes).size !== contextIndexes.length
    || contextIndexes.some((episodeIndex, index) => episodeIndex !== indexes[index])
  ) {
    throw new Error("Render operation reconciliationContext segments do not match segmentIndexes");
  }
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
