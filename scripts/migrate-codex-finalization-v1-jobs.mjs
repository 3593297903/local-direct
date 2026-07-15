import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.TS_NODE_COMPILER_OPTIONS ||= JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { atomicMoveFile, atomicReplaceJson } = require("../lib/file-job-store.ts");
const { readCodexRuntimeHealthForOwner } = require("../lib/codex-runtime-health.ts");
const { createSeasonPackCodexJob } = require("../lib/season-pack-codex-queue.ts");
const { createVideoPromptPackCodexJob } = require("../lib/video-prompt-pack-codex-queue.ts");

const MIGRATION_ROOT = ".tmp-codex-finalization-migration";
const MIGRATION_MAP_FILE = "v1-migration-map.json";
const VALID_ACTIONS = new Set(["dry-run", "requeue", "fail"]);
const QUEUES = [
  { key: "season", namespace: ".tmp-season-pack-codex", workerName: "season-pack" },
  { key: "render", namespace: ".tmp-video-prompt-pack-codex", workerName: "video-prompt-pack" },
];
const STATE_DIRS = ["pending", "running", "completed", "failed"];

export async function migrateCodexFinalizationV1Jobs(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const action = normalizeAction(options.action);
  const selectedQueue = normalizeQueue(options.queue);
  const heartbeatMaxAgeMs = positiveInteger(options.heartbeatMaxAgeMs, 90_000);
  const records = await collectV1Jobs(rootDir, selectedQueue);
  const mappingPath = path.join(rootDir, MIGRATION_ROOT, MIGRATION_MAP_FILE);
  const migrationMap = await readMigrationMap(mappingPath);
  const report = {
    schemaVersion: 1,
    action,
    queue: selectedQueue,
    modelCalls: 0,
    counts: {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      requeued: 0,
      failedByMigration: 0,
      alreadyMigrated: 0,
      healthyRunningSkipped: 0,
      unverifiableOwnerSkipped: 0,
      invalidOwnerSkipped: 0,
      terminalSkipped: 0,
    },
    jobs: [],
  };

  for (const record of records) {
    report.counts[record.status] += 1;
    const reportEntry = {
      queue: record.queue.key,
      status: record.status,
      jobId: redactJobId(record.job.id),
      decision: action === "dry-run" ? "would-review" : "skipped",
    };
    report.jobs.push(reportEntry);
    if (action === "dry-run") continue;

    const mappingKey = `${record.queue.key}:${record.job.id}`;
    const existing = migrationMap.entries[mappingKey];
    if (existing) {
      report.counts.alreadyMigrated += 1;
      reportEntry.decision = "already-migrated";
      if (existing.newJobId) reportEntry.newJobId = redactJobId(existing.newJobId);
      continue;
    }
    if (record.status === "completed" || record.status === "failed") {
      report.counts.terminalSkipped += 1;
      reportEntry.decision = "terminal-skipped";
      continue;
    }
    if (record.status === "running") {
      const ownerDecision = await readOriginalOwnerDecision(rootDir, record, heartbeatMaxAgeMs);
      reportEntry.ownerStatus = ownerDecision.status;
      reportEntry.ownerMatchKind = ownerDecision.matchKind;
      if (ownerDecision.status === "healthy") {
        report.counts.healthyRunningSkipped += 1;
        reportEntry.decision = "healthy-owner-skipped";
        continue;
      }
      if (ownerDecision.status === "unverifiable") {
        report.counts.unverifiableOwnerSkipped += 1;
        reportEntry.decision = "unverifiable-owner-skipped";
        continue;
      }
      if (ownerDecision.status === "invalid") {
        report.counts.invalidOwnerSkipped += 1;
        reportEntry.decision = "invalid-owner-skipped";
        continue;
      }
    }

    if (action === "requeue") {
      const replacement = await createV2Replacement(rootDir, record);
      migrationMap.entries[mappingKey] = {
        queue: record.queue.key,
        oldJobId: record.job.id,
        newJobId: replacement.id,
        action,
        migratedAt: new Date().toISOString(),
      };
      report.counts.requeued += 1;
      reportEntry.decision = "requeued";
      reportEntry.newJobId = redactJobId(replacement.id);
      continue;
    }

    await failLegacyRecord(rootDir, record);
    migrationMap.entries[mappingKey] = {
      queue: record.queue.key,
      oldJobId: record.job.id,
      newJobId: null,
      action,
      migratedAt: new Date().toISOString(),
    };
    report.counts.failedByMigration += 1;
    reportEntry.decision = "failed";
  }

  if (action !== "dry-run") {
    migrationMap.updatedAt = new Date().toISOString();
    await atomicReplaceJson(mappingPath, migrationMap, { rootDir });
  }
  return report;
}

async function collectV1Jobs(rootDir, selectedQueue) {
  const records = new Map();
  for (const queue of QUEUES.filter((item) => selectedQueue === "all" || item.key === selectedQueue)) {
    for (const state of STATE_DIRS) {
      const directory = path.join(rootDir, queue.namespace, state);
      for (const entry of await readJsonEntries(directory)) {
        if (Number(entry.value?.protocolVersion) === 2 || !entry.value?.id) continue;
        records.set(`${queue.key}:${entry.value.id}`, {
          queue,
          status: normalizeStatus(entry.value.status, state),
          job: entry.value,
          path: entry.path,
          storage: "state",
        });
      }
    }
    const legacyDirectory = path.join(rootDir, queue.namespace, "jobs");
    for (const entry of await readJsonEntries(legacyDirectory)) {
      if (Number(entry.value?.protocolVersion) === 2 || !entry.value?.id) continue;
      const key = `${queue.key}:${entry.value.id}`;
      if (records.has(key)) continue;
      records.set(key, {
        queue,
        status: normalizeStatus(entry.value.status, "pending"),
        job: entry.value,
        path: entry.path,
        storage: "legacy",
      });
    }
  }
  return [...records.values()].sort((left, right) => (
    `${left.queue.key}:${left.job.id}`.localeCompare(`${right.queue.key}:${right.job.id}`)
  ));
}

async function readJsonEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const output = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const target = path.join(directory, entry.name);
    try {
      output.push({ path: target, value: JSON.parse(await readFile(target, "utf8")) });
    } catch {
      // Invalid legacy files are reported by their owning queue; migration never rewrites them implicitly.
    }
  }
  return output;
}

async function readOriginalOwnerDecision(rootDir, record, maxAgeMs) {
  return readCodexRuntimeHealthForOwner(record.queue.workerName, record.job.workerId, {
    rootDir,
    maxAgeMs,
  });
}

async function createV2Replacement(rootDir, record) {
  if (record.queue.key === "season") {
    const mode = record.job.segmentCountMode === "auto" ? "auto" : "fixed";
    return createSeasonPackCodexJob({
      projectId: record.job.projectId || undefined,
      script: String(record.job.script || ""),
      segmentCountMode: mode,
      episodeCount: mode === "fixed"
        ? positiveInteger(record.job.requestedEpisodeCount || record.job.episodeCount, 1)
        : undefined,
      duration: record.job.duration,
      contentType: record.job.contentType,
      style: record.job.style,
      projectMemory: record.job.projectMemory,
    }, {
      rootDir,
      bypassV2CreatePause: true,
      migrationSourceJobId: record.job.id,
    });
  }

  const sourceSegments = record.job.outputTemplate?.segments || record.job.segments || [];
  return createVideoPromptPackCodexJob({
    idempotencyKey: `finalization-v1:${record.job.id}`,
    projectId: record.job.projectId || undefined,
    mode: record.job.mode,
    coverageSidecarEnabled: record.job.coverageSidecarEnabled,
    segments: sourceSegments.map((segment) => ({
      episodeIndex: segment.episodeIndex,
      title: segment.title,
      script: segment.script,
      renderInputScript: segment.renderInputScript,
      duration: segment.duration,
      shotCount: segment.shotCount || undefined,
      segmentContract: segment.segmentContract || undefined,
    })),
  }, { rootDir, bypassV2CreatePause: true });
}

async function failLegacyRecord(rootDir, record) {
  const failed = {
    ...record.job,
    status: "failed",
    stage: "failed",
    leaseId: null,
    workerId: null,
    heartbeatAt: new Date().toISOString(),
    error: "Protocol v1 job was explicitly failed by the finalization migration tool.",
    errorCode: "FINALIZATION_V1_MIGRATED_FAILED",
    updatedAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
  };
  await atomicReplaceJson(record.path, failed, { rootDir });
  if (record.storage === "state" && record.status !== "failed") {
    const destination = path.join(rootDir, record.queue.namespace, "failed", `${record.job.id}.json`);
    await atomicMoveFile(record.path, destination, { rootDir });
  }
}

async function readMigrationMap(target) {
  try {
    const parsed = JSON.parse(await readFile(target, "utf8"));
    return parsed?.schemaVersion === 1 && parsed.entries && typeof parsed.entries === "object"
      ? parsed
      : { schemaVersion: 1, updatedAt: null, entries: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, updatedAt: null, entries: {} };
    throw error;
  }
}

function normalizeAction(value) {
  const action = String(value || "dry-run").trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) throw new Error(`Unsupported migration action: ${action}`);
  return action;
}

function normalizeQueue(value) {
  const queue = String(value || "all").trim().toLowerCase();
  if (!["all", "season", "render"].includes(queue)) throw new Error(`Unsupported migration queue: ${queue}`);
  return queue;
}

function normalizeStatus(value, fallback) {
  const status = String(value || fallback).toLowerCase();
  return STATE_DIRS.includes(status) ? status : fallback;
}

function redactJobId(value) {
  const input = String(value || "");
  const label = input.split("-").slice(0, 3).join("-") || "job";
  return `${label}…${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith("--root-dir=")) options.rootDir = argument.slice("--root-dir=".length);
    else if (argument.startsWith("--queue=")) options.queue = argument.slice("--queue=".length);
    else if (argument.startsWith("--action=")) options.action = argument.slice("--action=".length);
    else if (argument.startsWith("--apply=")) options.action = argument.slice("--apply=".length);
    else if (argument === "--dry-run") options.action = "dry-run";
    else throw new Error(`Unknown migration argument: ${argument}`);
  }
  return options;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  migrateCodexFinalizationV1Jobs(parseCliArguments(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
