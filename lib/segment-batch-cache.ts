import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type SegmentBatchCacheDocument = {
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
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error("Segment batch cache schema is invalid");
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
  return { ...value, batchId };
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
