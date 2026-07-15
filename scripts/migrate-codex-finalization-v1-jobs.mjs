import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

process.env.TS_NODE_COMPILER_OPTIONS ||= JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { atomicReplaceJson, getFileJob } = require("../lib/file-job-store.ts");
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
const MIGRATION_LOCK_NAME = "codex-finalization-v1-migration";

export async function migrateCodexFinalizationV1Jobs(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fleetLock = await acquireWorkerFleetLock(MIGRATION_LOCK_NAME, { rootDir });
  if (!fleetLock.acquired) {
    throw new Error("Codex finalization v1 migration is already running");
  }
  try {
    await options.testHooks?.afterLockAcquired?.();
    return await migrateCodexFinalizationV1JobsWithLock(rootDir, options);
  } finally {
    await fleetLock.release();
  }
}

async function migrateCodexFinalizationV1JobsWithLock(rootDir, options) {
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
    judgeCalls: 0,
    repairCalls: 0,
    fallbackCalls: 0,
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
      reconciled: 0,
      identityMismatch: 0,
      actionConflict: 0,
      stateConflict: 0,
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
    const existing = migrationMap.entries[mappingKey] || null;
    const sourceMigration = readSourceMigration(record.job);
    if ((record.status === "completed" || record.status === "failed") && !sourceMigration) {
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

    const intent = resolvePersistedMigrationIntent(record, existing, action);
    if (intent.status === "state-conflict") {
      markMigrationConflict(
        report,
        reportEntry,
        "stateConflict",
        "FINALIZATION_V1_MIGRATION_STATE_CONFLICT",
        intent.error,
      );
      continue;
    }
    const persistedIdentityError = validatePersistedReplacementIdentity(record, existing, sourceMigration, intent);
    if (persistedIdentityError) {
      markIdentityMismatch(report, reportEntry, persistedIdentityError);
      continue;
    }
    if (intent.status === "action-conflict") {
      markMigrationConflict(
        report,
        reportEntry,
        "actionConflict",
        "FINALIZATION_V1_ACTION_CONFLICT",
        intent.error,
      );
      continue;
    }

    if (action === "requeue") {
      const expectedReplacementId = deterministicReplacementId(record);
      const referencedReplacementId = existing?.newJobId || sourceMigration?.replacementJobId || null;
      if (referencedReplacementId && referencedReplacementId !== expectedReplacementId) {
        markIdentityMismatch(report, reportEntry, "Migration map or source references an unexpected replacement job");
        continue;
      }

      let replacement;
      try {
        if (existing || sourceMigration) {
          await getFileJob(rootDir, record.queue.namespace, expectedReplacementId);
        }
        replacement = await createV2Replacement(rootDir, record);
        if (replacement.id !== expectedReplacementId) {
          throw identityMismatchError("Deterministic replacement ID does not match the legacy source");
        }
      } catch (error) {
        if (isIdentityMismatch(error) || (error instanceof Error && error.message === "File job not found")) {
          markIdentityMismatch(report, reportEntry, error instanceof Error ? error.message : String(error));
          continue;
        }
        throw error;
      }

      await options.testHooks?.afterReplacementCreated?.({ record, replacement });
      const sourceWasActive = record.status === "pending" || record.status === "running";
      let terminalSource = record.job;
      if (!sourceMigration || sourceWasActive) {
        terminalSource = await terminalizeLegacyRecord(rootDir, record, "requeue", replacement.id);
        await options.testHooks?.afterSourceTerminalized?.({ record, replacement, terminalSource });
      }
      if (!existing) {
        migrationMap.entries[mappingKey] = migrationMapEntry(record, "requeue", replacement.id, terminalSource);
        await persistMigrationMap(rootDir, mappingPath, migrationMap);
      }
      await verifyMigratedRecord(rootDir, record, replacement, migrationMap.entries[mappingKey] || existing);

      if ((existing && sourceWasActive) || (sourceMigration && !existing)) {
        report.counts.reconciled += 1;
        reportEntry.decision = "reconciled";
      } else if (existing || sourceMigration) {
        report.counts.alreadyMigrated += 1;
        reportEntry.decision = "already-migrated";
      } else {
        report.counts.requeued += 1;
        reportEntry.decision = "requeued";
      }
      reportEntry.newJobId = redactJobId(replacement.id);
      continue;
    }

    const sourceWasActive = record.status === "pending" || record.status === "running";
    let terminalSource = record.job;
    if (!sourceMigration || sourceWasActive) {
      terminalSource = await terminalizeLegacyRecord(rootDir, record, "fail", null);
      await options.testHooks?.afterSourceTerminalized?.({ record, replacement: null, terminalSource });
    }
    if (!existing) {
      migrationMap.entries[mappingKey] = migrationMapEntry(record, "fail", null, terminalSource);
      await persistMigrationMap(rootDir, mappingPath, migrationMap);
    }
    await verifyFailedMigrationRecord(rootDir, record, migrationMap.entries[mappingKey] || existing);

    if ((existing && sourceWasActive) || (sourceMigration && !existing)) {
      report.counts.reconciled += 1;
      reportEntry.decision = "reconciled";
    } else if (existing || sourceMigration) {
      report.counts.alreadyMigrated += 1;
      reportEntry.decision = "already-migrated";
    } else {
      report.counts.failedByMigration += 1;
      reportEntry.decision = "failed";
    }
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
        setPreferredRecord(records, `${queue.key}:${entry.value.id}`, {
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
      setPreferredRecord(records, key, {
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

function setPreferredRecord(records, key, candidate) {
  const existing = records.get(key);
  if (!existing || recordPriority(candidate) > recordPriority(existing)) records.set(key, candidate);
}

function recordPriority(record) {
  if (record.status === "running") return 50;
  if (record.status === "pending") return 40;
  if (record.job?.legacyMigrationState === "source_terminalized") return 30;
  if (record.status === "failed") return 20;
  return 10;
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

async function terminalizeLegacyRecord(rootDir, record, action, replacementJobId) {
  const migratedAt = new Date().toISOString();
  const failed = {
    ...record.job,
    status: "failed",
    stage: "failed",
    leaseId: null,
    workerId: null,
    heartbeatAt: new Date().toISOString(),
    error: action === "requeue"
      ? "Protocol v1 job was replaced by a deterministic protocol v2 task."
      : "Protocol v1 job was explicitly failed by the finalization migration tool.",
    errorCode: action === "requeue" ? "FINALIZATION_V1_REQUEUED" : "FINALIZATION_V1_MIGRATED_FAILED",
    legacyMigrationAction: action,
    legacyMigrationState: "source_terminalized",
    replacementJobId,
    migratedAt,
    updatedAt: migratedAt,
    failedAt: migratedAt,
  };
  const destination = path.join(rootDir, record.queue.namespace, "failed", `${record.job.id}.json`);
  await atomicReplaceJson(destination, failed, { rootDir });
  for (const activePath of legacyActivePaths(rootDir, record)) {
    if (path.resolve(activePath) === path.resolve(destination)) continue;
    const active = await readJsonFile(activePath);
    if (
      active?.id === record.job.id
      && Number(active.protocolVersion) !== 2
      && ["pending", "running"].includes(normalizeStatus(active.status, "pending"))
    ) {
      await rm(activePath, { force: true });
    }
  }
  return failed;
}

function legacyActivePaths(rootDir, record) {
  const fileName = `${record.job.id}.json`;
  return [...new Set([
    record.path,
    path.join(rootDir, record.queue.namespace, "pending", fileName),
    path.join(rootDir, record.queue.namespace, "running", fileName),
    path.join(rootDir, record.queue.namespace, "jobs", fileName),
  ])];
}

async function readJsonFile(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readSourceMigration(job) {
  if (job?.legacyMigrationState !== "source_terminalized") return null;
  return {
    action: job.legacyMigrationAction,
    replacementJobId: job.replacementJobId || null,
    migratedAt: job.migratedAt || null,
  };
}

export function resolvePersistedMigrationIntent(record, existingMapEntry, requestedAction) {
  const sourceMigration = readSourceMigration(record?.job);
  const rawSourceAction = record?.job?.legacyMigrationAction;
  const sourceActionPresent = rawSourceAction !== undefined && rawSourceAction !== null && rawSourceAction !== "";
  const sourceAction = normalizePersistedAction(rawSourceAction);
  const mapAction = normalizePersistedAction(existingMapEntry?.action);

  if ((sourceActionPresent && !sourceAction) || (existingMapEntry && !mapAction)) {
    return {
      status: "state-conflict",
      persistedAction: sourceAction || mapAction,
      replacementJobId: existingMapEntry?.newJobId || sourceMigration?.replacementJobId || null,
      error: "Persisted migration state contains an invalid or missing action",
    };
  }
  if (sourceAction && mapAction && sourceAction !== mapAction) {
    return {
      status: "state-conflict",
      persistedAction: null,
      replacementJobId: existingMapEntry?.newJobId || sourceMigration?.replacementJobId || null,
      error: `Source migration action ${sourceAction} conflicts with map action ${mapAction}`,
    };
  }

  const persistedAction = sourceAction || mapAction || null;
  if (persistedAction && persistedAction !== requestedAction) {
    return {
      status: "action-conflict",
      persistedAction,
      replacementJobId: existingMapEntry?.newJobId || sourceMigration?.replacementJobId || null,
      error: `Requested migration action ${requestedAction} conflicts with persisted action ${persistedAction}`,
    };
  }
  return {
    status: persistedAction ? "same-action" : "new",
    persistedAction,
    replacementJobId: existingMapEntry?.newJobId || sourceMigration?.replacementJobId || null,
  };
}

function normalizePersistedAction(value) {
  const action = String(value || "").trim().toLowerCase();
  return action === "requeue" || action === "fail" ? action : null;
}

function validatePersistedReplacementIdentity(record, existingMapEntry, sourceMigration, intent) {
  if (!intent.persistedAction) return null;
  const references = [];
  if (existingMapEntry) references.push({ label: "migration map", value: existingMapEntry.newJobId ?? null });
  if (sourceMigration) references.push({ label: "source audit", value: sourceMigration.replacementJobId ?? null });

  if (intent.persistedAction === "fail") {
    const invalid = references.find((reference) => reference.value !== null);
    return invalid ? `${invalid.label} contains a replacement for a persisted fail action` : null;
  }

  const expectedReplacementId = deterministicReplacementId(record);
  const invalid = references.find((reference) => reference.value !== expectedReplacementId);
  return invalid
    ? `${invalid.label} does not reference the deterministic replacement job`
    : null;
}

function deterministicReplacementId(record) {
  if (record.queue.key === "season") {
    return `season-pack-job-${createHash("sha256").update(`finalization-v1:${record.job.id}`).digest("hex").slice(0, 32)}`;
  }
  return `video-prompt-pack-job-${createHash("sha256").update(`finalization-v1:${record.job.id}`).digest("hex").slice(0, 32)}`;
}

function migrationMapEntry(record, action, replacementJobId, terminalSource) {
  return {
    queue: record.queue.key,
    oldJobId: record.job.id,
    newJobId: replacementJobId,
    action,
    migratedAt: terminalSource.migratedAt || new Date().toISOString(),
  };
}

async function persistMigrationMap(rootDir, mappingPath, migrationMap) {
  migrationMap.updatedAt = new Date().toISOString();
  await atomicReplaceJson(mappingPath, migrationMap, { rootDir });
}

async function verifyMigratedRecord(rootDir, record, replacement, mapEntry) {
  if (mapEntry.newJobId !== replacement.id) throw identityMismatchError("Migration map replacement identity changed");
  const failedPath = path.join(rootDir, record.queue.namespace, "failed", `${record.job.id}.json`);
  const source = await readJsonFile(failedPath);
  if (
    source?.legacyMigrationState !== "source_terminalized"
    || source.replacementJobId !== replacement.id
    || source.errorCode !== "FINALIZATION_V1_REQUEUED"
  ) {
    throw new Error("Legacy migration source terminalization could not be verified");
  }
  for (const activePath of legacyActivePaths(rootDir, record)) {
    if (path.resolve(activePath) === path.resolve(failedPath)) continue;
    const active = await readJsonFile(activePath);
    if (active?.id === record.job.id && Number(active.protocolVersion) !== 2) {
      throw new Error("Legacy migration source remains active after terminalization");
    }
  }
}

async function verifyFailedMigrationRecord(rootDir, record, mapEntry) {
  if (mapEntry?.action !== "fail" || mapEntry.newJobId !== null) {
    throw identityMismatchError("Failed migration map must preserve action=fail and a null replacement identity");
  }
  const failedPath = path.join(rootDir, record.queue.namespace, "failed", `${record.job.id}.json`);
  const source = await readJsonFile(failedPath);
  if (
    source?.legacyMigrationState !== "source_terminalized"
    || source.legacyMigrationAction !== "fail"
    || source.replacementJobId !== null
    || source.errorCode !== "FINALIZATION_V1_MIGRATED_FAILED"
  ) {
    throw new Error("Failed legacy migration source terminalization could not be verified");
  }
  for (const activePath of legacyActivePaths(rootDir, record)) {
    if (path.resolve(activePath) === path.resolve(failedPath)) continue;
    const active = await readJsonFile(activePath);
    if (active?.id === record.job.id && Number(active.protocolVersion) !== 2) {
      throw new Error("Failed legacy migration source remains active after terminalization");
    }
  }
}

function identityMismatchError(message) {
  const error = new Error(message);
  error.code = "FINALIZATION_IDENTITY_MISMATCH";
  return error;
}

function isIdentityMismatch(error) {
  return error?.code === "FINALIZATION_IDENTITY_MISMATCH";
}

function markIdentityMismatch(report, reportEntry, message) {
  report.counts.identityMismatch += 1;
  reportEntry.decision = "manual-review";
  reportEntry.errorCode = "FINALIZATION_IDENTITY_MISMATCH";
  reportEntry.error = String(message || "Replacement identity mismatch");
}

function markMigrationConflict(report, reportEntry, countKey, errorCode, message) {
  report.counts[countKey] += 1;
  reportEntry.decision = "manual-review";
  reportEntry.errorCode = errorCode;
  reportEntry.error = String(message || "Persisted migration intent conflict");
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
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.counts.actionConflict > 0 || report.counts.stateConflict > 0) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
