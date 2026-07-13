import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_DIRECTOR_ROOT = path.resolve("E:\\localdirector");
const JOB_STATUS_DIRECTORIES = new Set(["pending", "running", "completed", "failed"]);
const TIMING_DEFINITIONS = Object.freeze({
  queueWaitMs: ["createdAt", "executingAt"],
  slotWaitMs: ["waitingSlotAt", "executingAt"],
  executionMs: ["executingAt", "codexExitedAt"],
  finalizationMs: ["codexExitedAt", "completedAt"],
  wallMs: ["createdAt", "completedAt"],
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

async function listJsonFiles(root) {
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
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(target);
    }
  }

  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Artifact root does not exist: ${root}`);
    throw error;
  }

  const candidateDirectories = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".tmp-"))
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));

  if (path.basename(root).startsWith(".tmp-")) candidateDirectories.unshift(root);
  for (const directory of [...new Set(candidateDirectories)]) await visit(directory);
  return files;
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

function collectReferencedJobIds(value, references = new Set(), key = "") {
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedJobIds(item, references, key);
    return references;
  }
  if (!isRecord(value)) return references;
  for (const [childKey, childValue] of Object.entries(value)) {
    const normalizedKey = childKey.toLowerCase();
    if (/jobids?$/.test(normalizedKey)) {
      const values = Array.isArray(childValue) ? childValue : [childValue];
      for (const candidate of values) {
        const id = cleanString(candidate);
        if (id) references.add(id);
      }
    }
    collectReferencedJobIds(childValue, references, normalizedKey || key);
  }
  return references;
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
  const files = await listJsonFiles(absoluteRoot);
  const jobs = [];
  const results = [];
  const referencedJobIds = new Set();
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
    collectReferencedJobIds(value, referencedJobIds);
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
  const orphanCompletedResults = [];
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
      if (!referencedJobIds.has(result.jobId)) {
        orphanCompletedResults.push({
          jobId: result.jobId,
          resultPath: result.path,
          resultSha256: result.sha256,
          resultBytes: result.bytes,
        });
      }
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: absoluteRoot,
    filesScanned: files.length,
    jobsScanned: jobs.length,
    resultsScanned: results.length,
    statusCounts: Object.fromEntries(Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right))),
    timingsByTaskClass,
    failures: Object.fromEntries(Object.entries(failures).sort(([left], [right]) => left.localeCompare(right))),
    modelInvocationCounts: Object.fromEntries(
      Object.entries(invocationCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    duplicates,
    completedBeforeFinalOutput: completedBeforeFinalOutput.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    orphanCompletedResults: orphanCompletedResults.sort((left, right) => left.jobId.localeCompare(right.jobId)),
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
