import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_DIRECTOR_ROOT = path.resolve("E:\\localdirector");
const JOB_STATUS_DIRECTORIES = new Set(["pending", "running", "completed", "failed"]);
const ARTIFACT_SCAN_ROOTS = Object.freeze([
  ".tmp-batch-segment-repair-codex",
  ".tmp-event-coverage-codex",
  ".tmp-prompt-safety-codex",
  ".tmp-season-pack-codex",
  ".tmp-segment-batch-cache",
  ".tmp-video-prompt-codex",
  ".tmp-video-prompt-pack-codex",
]);
const ARTIFACT_SCAN_ROOT_SET = new Set(ARTIFACT_SCAN_ROOTS);
const INVOCATION_METRIC_NAMES = Object.freeze([
  "renderPackCalls",
  "singleRegenerationCalls",
  "pathPatchJobCreated",
  "pathPatchCompleted",
  "judgeCalls",
  "localPatchOperations",
]);
const TIMING_DEFINITIONS = Object.freeze({
  queueWaitMs: ["createdAt", "executingAt"],
  slotWaitMs: ["waitingSlotAt", "executingAt"],
  executionMs: ["executingAt", "codexExitedAt"],
  finalizationMs: ["codexExitedAt", "completedAt"],
  wallMs: ["createdAt", "completedAt"],
  claimWaitSupplementMs: ["createdAt", "startedAt"],
  workerWallSupplementMs: ["startedAt", "completedAt"],
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeSafe(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateArtifactRoot(root, { allowExternalRead = false } = {}) {
  const absoluteRoot = path.resolve(cleanString(root) || ".");
  if (!allowExternalRead && !isInside(LOCAL_DIRECTOR_ROOT, absoluteRoot)) {
    throw new Error(
      `Artifact root ${absoluteRoot} is outside E:\\localdirector; pass --allow-external-read to inspect it.`,
    );
  }
  return absoluteRoot;
}

async function listJsonFiles(root, excludedFiles = new Set()) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (
        entry.isFile()
        && entry.name.toLowerCase().endsWith(".json")
        && !excludedFiles.has(path.resolve(target).toLowerCase())
      ) {
        files.push(target);
      }
    }
  }

  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Artifact root does not exist: ${root}`);
    throw error;
  }

  const rootName = path.basename(root);
  const candidateDirectories = ARTIFACT_SCAN_ROOT_SET.has(rootName)
    ? [root]
    : ARTIFACT_SCAN_ROOTS
      .filter((name) => rootEntries.some((entry) => entry.isDirectory() && entry.name === name))
      .map((name) => path.join(root, name));
  for (const directory of [...new Set(candidateDirectories)]) await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarizeTiming(samples, unknown) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    unknown,
    min: sorted.length ? sorted[0] : null,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted.at(-1) : null,
  };
}

function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function timingValue(job, startKey, endKey) {
  const start = timestamp(job[startKey]);
  const end = timestamp(job[endKey]);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function inferTaskClass(file, value) {
  const explicit = cleanString(value.taskClass || value.kind || value.type);
  if (explicit) return explicit.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  const directory = file.split(path.sep).find((part) => part.startsWith(".tmp-")) || "unknown";
  return directory.replace(/^\.tmp-/, "").replace(/-codex(?:-jobs)?$/, "").replace(/-/g, "_");
}

function inferStatus(file, value) {
  const explicit = cleanString(value.status).toLowerCase();
  if (explicit) return explicit;
  const parts = file.split(path.sep).map((part) => part.toLowerCase());
  return parts.find((part) => JOB_STATUS_DIRECTORIES.has(part)) || "unknown";
}

function isJobFile(file, value) {
  if (!isRecord(value)) return false;
  const parts = file.split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part) => JOB_STATUS_DIRECTORIES.has(part));
}

function resultJobId(file, value) {
  const explicit = cleanString(value?.jobId || value?.taskId);
  if (explicit) return explicit;
  const parts = file.split(path.sep);
  const resultIndex = parts.findIndex((part) => part.toLowerCase() === "results");
  return resultIndex >= 0 ? cleanString(parts[resultIndex + 1]) : "";
}

function isResultFile(file) {
  return file.split(path.sep).some((part) => part.toLowerCase() === "results");
}

function isDurableSegmentBatchCache(value) {
  return isRecord(value)
    && value.schemaVersion === 2
    && Number.isInteger(value.revision)
    && value.revision >= 0
    && cleanString(value.batchId)
    && cleanString(value.durableBatchId)
    && cleanString(value.sourceHash)
    && cleanString(value.contractHash)
    && Number.isInteger(value.resolvedSegmentCount)
    && value.resolvedSegmentCount > 0
    && Array.isArray(value.segmentStates)
    && Array.isArray(value.activeJobIds)
    && Array.isArray(value.qualityReports)
    && Array.isArray(value.segments)
    && Array.isArray(value.needsReviewSegments);
}

function createHistoricalInvocationCounts() {
  return Object.fromEntries(
    INVOCATION_METRIC_NAMES.map((name) => [name, { known: 0, unknown: 0, samples: 0 }]),
  );
}

function collectDurableCacheEvidence(value, references, historicalCounts) {
  for (const candidate of value.activeJobIds) {
    const id = cleanString(candidate);
    if (id) references.add(id);
  }
  for (const state of value.segmentStates) {
    const id = cleanString(isRecord(state) ? state.activeRepairJobId : "");
    if (id) references.add(id);
  }

  const events = Array.isArray(value.invocationEvents) ? value.invocationEvents : [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    const id = cleanString(event.jobId);
    if (id) references.add(id);
  }
  for (const name of INVOCATION_METRIC_NAMES) {
    const matching = events.filter((event) => isRecord(event) && event.name === name);
    if (matching.length === 0) {
      historicalCounts[name].unknown += 1;
      continue;
    }
    for (const event of matching) {
      const count = Number(event.count);
      if (!Number.isFinite(count) || count < 0) {
        historicalCounts[name].unknown += 1;
        continue;
      }
      historicalCounts[name].known += count;
      historicalCounts[name].samples += 1;
    }
  }
}

function segmentIndexes(value) {
  const candidates = value.segmentIndexes || value.episodeIndexes || value.segments;
  if (!Array.isArray(candidates)) return [];
  return [...new Set(candidates.map((item) => Number(item)).filter(Number.isInteger))].sort((a, b) => a - b);
}

function stableFailureKey(job) {
  const errorCode = cleanString(job.errorCode || job.code);
  if (errorCode) return errorCode;
  const message = cleanString(job.error || job.errorMessage || job.message);
  const firstLine = message.split(/\r?\n/, 1)[0] || "UNKNOWN_ERROR";
  return `FIRST_LINE_SHA256:${sha256(firstLine)}`;
}

function duplicateIdentity(job) {
  const sourceHash = cleanString(job.sourceHash);
  const contractHash = cleanString(job.contractHash || job.batchContractHash);
  const indexes = segmentIndexes(job);
  if (!sourceHash || !contractHash || indexes.length === 0) return null;
  return {
    key: `${sourceHash}|${contractHash}|${indexes.join(",")}`,
    sourceHash,
    contractHash,
    segmentIndexes: indexes,
  };
}

function emptyTaskTiming() {
  return Object.fromEntries(
    Object.keys(TIMING_DEFINITIONS).map((key) => [key, { samples: [], unknown: 0 }]),
  );
}

export async function analyzeBatchJobArtifacts({ root, outputPath, allowExternalRead = false }) {
  const absoluteRoot = validateArtifactRoot(root, { allowExternalRead });
  const absoluteOutput = outputPath ? path.resolve(outputPath) : null;
  const excludedFiles = new Set(absoluteOutput ? [absoluteOutput.toLowerCase()] : []);
  const files = await listJsonFiles(absoluteRoot, excludedFiles);
  const jobs = [];
  const results = [];
  const referencedJobIds = new Set();
  const historicalInvocationCounts = createHistoricalInvocationCounts();
  let durableCacheDocuments = 0;
  let ignoredCacheDocuments = 0;
  const parseErrors = [];

  for (const file of files) {
    let raw;
    let value;
    try {
      raw = await readFile(file, "utf8");
      value = JSON.parse(raw);
    } catch (error) {
      parseErrors.push({
        path: relativeSafe(absoluteRoot, file),
        errorCode: cleanString(error?.code) || "INVALID_JSON",
      });
      continue;
    }

    const fileStat = await stat(file);
    if (isResultFile(file)) {
      const jobId = resultJobId(file, value);
      results.push({
        jobId,
        path: relativeSafe(absoluteRoot, file),
        bytes: Buffer.byteLength(raw, "utf8"),
        sha256: sha256(raw),
        mtimeMs: fileStat.mtimeMs,
      });
      continue;
    }
    if (isJobFile(file, value)) {
      jobs.push({
        id: cleanString(value.id || value.jobId) || path.basename(file, path.extname(file)),
        file,
        relativePath: relativeSafe(absoluteRoot, file),
        value,
        status: inferStatus(file, value),
        taskClass: inferTaskClass(file, value),
      });
      continue;
    }
    const artifactRootName = relativeSafe(absoluteRoot, file).split("/", 1)[0];
    if (artifactRootName === ".tmp-segment-batch-cache") {
      if (isDurableSegmentBatchCache(value)) {
        durableCacheDocuments += 1;
        collectDurableCacheEvidence(value, referencedJobIds, historicalInvocationCounts);
      } else {
        ignoredCacheDocuments += 1;
      }
    }
  }

  if (durableCacheDocuments === 0) {
    for (const name of INVOCATION_METRIC_NAMES) historicalInvocationCounts[name].unknown += 1;
  }

  const statusCounts = {};
  const failures = {};
  const timingBuckets = new Map();
  const identityBuckets = new Map();
  const jobsById = new Map();
  const invocationCounts = {};

  for (const job of jobs) {
    statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;
    jobsById.set(job.id, job);
    if (!timingBuckets.has(job.taskClass)) timingBuckets.set(job.taskClass, emptyTaskTiming());
    const timing = timingBuckets.get(job.taskClass);
    for (const [metric, [startKey, endKey]] of Object.entries(TIMING_DEFINITIONS)) {
      const value = timingValue(job.value, startKey, endKey);
      if (value === null) timing[metric].unknown += 1;
      else timing[metric].samples.push(value);
    }
    if (job.status === "failed") {
      const key = stableFailureKey(job.value);
      failures[key] = (failures[key] || 0) + 1;
    }
    const identity = duplicateIdentity(job.value);
    if (identity) {
      const bucket = identityBuckets.get(identity.key) || { ...identity, jobIds: [] };
      bucket.jobIds.push(job.id);
      identityBuckets.set(identity.key, bucket);
    }
    if (timestamp(job.value.executingAt) !== null) {
      invocationCounts[job.taskClass] = (invocationCounts[job.taskClass] || 0) + 1;
    }
  }

  const timingsByTaskClass = {};
  for (const [taskClass, timing] of [...timingBuckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    timingsByTaskClass[taskClass] = Object.fromEntries(
      Object.entries(timing).map(([metric, bucket]) => [metric, summarizeTiming(bucket.samples, bucket.unknown)]),
    );
  }

  const duplicates = [...identityBuckets.values()]
    .filter((item) => item.jobIds.length > 1)
    .map((item) => ({
      identityHash: sha256(item.key),
      sourceHash: item.sourceHash,
      contractHash: item.contractHash,
      segmentIndexes: item.segmentIndexes,
      jobIds: [...item.jobIds].sort(),
    }))
    .sort((left, right) => left.identityHash.localeCompare(right.identityHash));

  const completedBeforeFinalOutput = [];
  const matchingCompletedResults = [];
  const matchingNonCompletedResults = [];
  const resultWithoutJob = [];
  for (const result of results) {
    const job = jobsById.get(result.jobId);
    if (job?.status === "completed") {
      const completedAt = timestamp(job.value.completedAt);
      if (completedAt !== null && result.mtimeMs > completedAt) {
        completedBeforeFinalOutput.push({
          jobId: result.jobId,
          resultPath: result.path,
          resultSha256: result.sha256,
          resultBytes: result.bytes,
          outputModifiedAfterCompletionMs: Math.round(result.mtimeMs - completedAt),
        });
      }
      matchingCompletedResults.push({
        jobId: result.jobId,
        resultPath: result.path,
        resultSha256: result.sha256,
        resultBytes: result.bytes,
        referenceStatus: referencedJobIds.has(result.jobId) ? "referenced" : "unknown",
      });
    } else if (job) {
      matchingNonCompletedResults.push({
        jobId: result.jobId,
        jobStatus: job.status,
        resultPath: result.path,
        resultSha256: result.sha256,
        resultBytes: result.bytes,
        referenceStatus: referencedJobIds.has(result.jobId) ? "referenced" : "unknown",
      });
    } else {
      resultWithoutJob.push({
        jobId: result.jobId || null,
        resultPath: result.path,
        resultSha256: result.sha256,
        resultBytes: result.bytes,
      });
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: ".",
    scanRoots: [...ARTIFACT_SCAN_ROOTS],
    filesScanned: files.length,
    jobsScanned: jobs.length,
    resultsScanned: results.length,
    durableCacheDocuments,
    ignoredCacheDocuments,
    statusCounts: Object.fromEntries(Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right))),
    timingsByTaskClass,
    failures: Object.fromEntries(Object.entries(failures).sort(([left], [right]) => left.localeCompare(right))),
    modelInvocationCounts: Object.fromEntries(
      Object.entries(invocationCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    historicalInvocationCounts,
    duplicates,
    completedBeforeFinalOutput: completedBeforeFinalOutput.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    matchingCompletedResults: matchingCompletedResults.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    matchingNonCompletedResults: matchingNonCompletedResults.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    resultWithoutJob: resultWithoutJob.sort((left, right) => String(left.jobId).localeCompare(String(right.jobId))),
    orphanCompletedResults: [],
    parseErrors,
  };

  if (absoluteOutput) {
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function parseArguments(argv) {
  const options = { allowExternalRead: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-external-read") {
      options.allowExternalRead = true;
      continue;
    }
    if (argument.startsWith("--root=")) options.root = argument.slice("--root=".length);
    else if (argument === "--root") options.root = argv[++index];
    else if (argument.startsWith("--output=")) options.outputPath = argument.slice("--output=".length);
    else if (argument === "--output") options.outputPath = argv[++index];
  }
  if (!options.root) throw new Error("Missing required --root=<task-root> argument.");
  if (!options.outputPath) throw new Error("Missing required --output=<report.json> argument.");
  return options;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const absoluteRoot = validateArtifactRoot(options.root, options);
    process.stdout.write(`Artifact root: ${absoluteRoot}\n`);
    const report = await analyzeBatchJobArtifacts(options);
    process.stdout.write(
      `Analyzed ${report.jobsScanned} jobs and ${report.resultsScanned} results; report: ${path.resolve(options.outputPath)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
