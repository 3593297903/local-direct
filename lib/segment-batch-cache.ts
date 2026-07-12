import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SegmentStateRecord } from "./batch-segment-progress";
import type { BatchInvocationLedgerEvent } from "./batch-repair-scheduler";
export {
  buildSegmentBatchLeaseOwnerKey,
  buildSegmentBatchRecoveryKey,
  buildSegmentBatchRecoveryKeys,
  buildStableBatchContractHash,
} from "./segment-batch-cache-identity";
export type {
  SegmentBatchRecoveryIdentity,
  StableBatchContractIdentity,
} from "./segment-batch-cache-identity";

export type SegmentBatchCacheDocumentV1 = {
  schemaVersion: 1;
  batchId: string;
  projectId?: string | null;
  sourceHash: string;
  contractHash: string;
  resolvedSegmentCount: number;
  updatedAt: string;
  phase?: string;
  segmentStates?: Array<{ index: number; status: string; message?: string }>;
  qualityReports: unknown[];
  segments: unknown[];
  needsReviewSegments: unknown[];
  coverageStage?: string;
  renderRound?: number;
  repairAttempts?: Array<[string, number]>;
  leaseOwnerId?: string;
  leaseExpiresAt?: string;
};

export type SegmentBatchCacheDocumentV2 = {
  schemaVersion: 2;
  revision: number;
  batchId: string;
  durableBatchId: string;
  projectId?: string | null;
  sourceHash: string;
  contractHash: string;
  resolvedSegmentCount: number;
  updatedAt: string;
  phase?: string;
  segmentStates: SegmentStateRecord[];
  activeJobIds: string[];
  qualityReports: unknown[];
  segments: unknown[];
  needsReviewSegments: unknown[];
  coverageStage?: string;
  renderRound?: number;
  repairAttempts?: Array<[string, number]>;
  leaseOwnerId?: string;
  leaseExpiresAt?: string;
  mode?: "fixed" | "auto";
  requestedCount?: number | null;
  duration?: string;
  invocationEvents?: BatchInvocationLedgerEvent[];
};

export type SegmentBatchCacheDocument = SegmentBatchCacheDocumentV1 | SegmentBatchCacheDocumentV2;

type CacheOptions = { rootDir?: string };
const CACHE_DIR = ".tmp-segment-batch-cache";

export async function writeSegmentBatchCache(
  input: SegmentBatchCacheDocument,
  options: CacheOptions = {},
) {
  const document = validateCacheDocument(input);
  const target = cachePath(document.batchId, options);
  await mkdir(path.dirname(target), { recursive: true });
  const lockPath = `${target}.lock`;
  await acquireCacheLock(lockPath);
  try {
    const current = await readSegmentBatchCache(document.batchId, options);
    if (
      current?.schemaVersion === 2
      && document.schemaVersion === 2
      && document.revision < current.revision
    ) {
      throw new Error("Segment batch cache revision is stale");
    }
    if (
      current?.leaseOwnerId
      && current.leaseOwnerId !== document.leaseOwnerId
      && Number.isFinite(Date.parse(current.leaseExpiresAt || ""))
      && Date.parse(current.leaseExpiresAt || "") > Date.now()
    ) {
      throw new Error("Segment batch cache is leased by another active generator");
    }
    const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return document;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function readSegmentBatchCache(batchId: string, options: CacheOptions = {}) {
  const target = cachePath(validateBatchId(batchId), options);
  try {
    return validateCacheDocument(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateCacheDocument(value: SegmentBatchCacheDocument) {
  if (!value || typeof value !== "object" || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error("Segment batch cache schema is invalid");
  }
  const batchId = validateBatchId(value.batchId);
  if (!value.sourceHash || !value.contractHash) throw new Error("Segment batch cache identity is incomplete");
  if (!Number.isInteger(value.resolvedSegmentCount) || value.resolvedSegmentCount < 1 || value.resolvedSegmentCount > 30) {
    throw new Error("Segment batch cache count is invalid");
  }
  if (!Array.isArray(value.segments) || !Array.isArray(value.qualityReports) || !Array.isArray(value.needsReviewSegments)) {
    throw new Error("Segment batch cache collections are invalid");
  }
  if (value.segmentStates && !Array.isArray(value.segmentStates)) throw new Error("Segment batch cache states are invalid");
  if (value.repairAttempts && !Array.isArray(value.repairAttempts)) throw new Error("Segment batch cache repairAttempts is invalid");
  if (value.leaseExpiresAt && !Number.isFinite(Date.parse(value.leaseExpiresAt))) throw new Error("Segment batch cache lease expiry is invalid");
  if (value.schemaVersion === 2) {
    if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error("Segment batch cache revision is invalid");
    if (!value.durableBatchId || !Array.isArray(value.activeJobIds) || !Array.isArray(value.segmentStates)) {
      throw new Error("Segment batch cache v2 state is incomplete");
    }
    if (value.invocationEvents && !Array.isArray(value.invocationEvents)) {
      throw new Error("Segment batch cache invocation ledger is invalid");
    }
  }
  return { ...value, batchId };
}

export function migrateSegmentBatchCacheDocument(
  value: SegmentBatchCacheDocument,
  now = Date.now(),
): SegmentBatchCacheDocumentV2 {
  const validated = validateCacheDocument(value);
  if (validated.schemaVersion === 2) return validated;
  const legacyStates = new Map((validated.segmentStates || []).map((state) => [state.index, state]));
  const savedStatuses = new Map<number, string>();
  for (const segment of validated.segments) {
    if (!segment || typeof segment !== "object") continue;
    const record = segment as Record<string, unknown>;
    const index = Number(record.episodeIndex);
    if (Number.isInteger(index)) savedStatuses.set(index, String(record.status || "cached"));
  }
  const segmentStates: SegmentStateRecord[] = Array.from(
    { length: validated.resolvedSegmentCount },
    (_, offset) => {
      const index = offset + 1;
      const status = savedStatuses.get(index) || legacyStates.get(index)?.status || "pending";
      const review = status === "needs_review" || status === "review_saved";
      const saved = status === "saved" || status === "review_saved";
      const cached = status === "cached" || status === "needs_review" || saved;
      return {
        index,
        generationStatus: cached ? "settled" : status === "running" ? "rendering" : "pending",
        qualityStatus: review ? "needs_review" : cached ? "passed" : "unknown",
        saveStatus: saved ? (review ? "review_saved" : "saved") : cached ? "cached" : "not_ready",
        revision: 0,
        saveRetryCount: 0,
        message: legacyStates.get(index)?.message,
        updatedAt: now,
      };
    },
  );
  return {
    ...validated,
    schemaVersion: 2,
    revision: 0,
    durableBatchId: validated.batchId,
    segmentStates,
    activeJobIds: [],
    invocationEvents: [],
  };
}

async function acquireCacheLock(lockPath: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Segment batch cache lock timed out");
}

function validateBatchId(value: string) {
  const batchId = String(value || "").trim();
  if (!batchId || batchId.length > 240 || !/^[A-Za-z0-9._:-]+$/.test(batchId)) throw new Error("Segment batch cache batchId is invalid");
  return batchId;
}

function cachePath(batchId: string, options: CacheOptions) {
  return path.join(path.resolve(options.rootDir || process.cwd()), CACHE_DIR, `${batchId}.json`);
}
