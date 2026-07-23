import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withAuthoritativeRenderPackInput } from "./helpers/authoritative-render-pack-fixture.mjs";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const { createSeasonPackCodexJob } = require("../lib/season-pack-codex-queue.ts");
const videoPromptPackQueue = require("../lib/video-prompt-pack-codex-queue.ts");
const { createVideoPromptPackCodexJob: createRawVideoPromptPackCodexJob } = videoPromptPackQueue;
const { normalizeSegmentContract } = require("../lib/batch-segment-contract.ts");
const { compileSegmentContractForPrompt } = require("../lib/codex-prompt-input-compiler.ts");

async function createVideoPromptPackCodexJob(input, options) {
  return createRawVideoPromptPackCodexJob(
    withAuthoritativeRenderPackInput(input, {
      normalizeSegmentContract,
      compileSegmentContractForPrompt,
    }),
    options,
  );
}

// The dynamically loaded migration module resolves this cached CommonJS export.
videoPromptPackQueue.createVideoPromptPackCodexJob = createVideoPromptPackCodexJob;

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-finalization-v1-migration-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function loadMigrationModule() {
  return import(`${pathToFileURL(path.resolve("scripts/migrate-codex-finalization-v1-jobs.mjs")).href}?test=${Date.now()}`);
}

function markPendingAsV1(rootDir, namespace, jobId) {
  const target = path.join(rootDir, namespace, "pending", `${jobId}.json`);
  const record = JSON.parse(readFileSync(target, "utf8"));
  writeFileSync(target, `${JSON.stringify({ ...record, protocolVersion: 1 }, null, 2)}\n`, "utf8");
  return target;
}

function snapshotFiles(rootDir) {
  const output = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else output.push([path.relative(rootDir, target), readFileSync(target, "utf8")]);
    }
  }
  visit(rootDir);
  return output.sort(([left], [right]) => left.localeCompare(right));
}

function readStateJobs(rootDir, namespace, state) {
  const directory = path.join(rootDir, namespace, state);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")));
}

function countActiveV1Jobs(rootDir, namespace, jobId) {
  const stateCount = ["pending", "running"]
    .flatMap((state) => readStateJobs(rootDir, namespace, state))
    .filter((job) => job.id === jobId && Number(job.protocolVersion) !== 2).length;
  const legacyPath = path.join(rootDir, namespace, "jobs", `${jobId}.json`);
  if (!existsSync(legacyPath)) return stateCount;
  const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  return stateCount + (legacy.id === jobId && Number(legacy.protocolVersion) !== 2
    && ["pending", "running"].includes(String(legacy.status || "pending")) ? 1 : 0);
}

function countV2Jobs(rootDir, namespace) {
  return ["pending", "running", "completed", "failed"]
    .flatMap((state) => readStateJobs(rootDir, namespace, state))
    .filter((job) => Number(job.protocolVersion) === 2).length;
}

function readFailedJob(rootDir, namespace, jobId) {
  return JSON.parse(readFileSync(path.join(rootDir, namespace, "failed", `${jobId}.json`), "utf8"));
}

function writeMigrationMap(rootDir, entries) {
  const directory = path.join(rootDir, ".tmp-codex-finalization-migration");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "v1-migration-map.json"), `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries,
  }, null, 2)}\n`, "utf8");
}

function migrationMapPath(rootDir) {
  return path.join(rootDir, ".tmp-codex-finalization-migration", "v1-migration-map.json");
}

function readMigrationMapBytes(rootDir) {
  return readFileSync(migrationMapPath(rootDir), "utf8");
}

function movePendingV1ToState(rootDir, namespace, jobId, state, overrides = {}) {
  const pendingPath = path.join(rootDir, namespace, "pending", `${jobId}.json`);
  const stateDirectory = path.join(rootDir, namespace, state);
  const statePath = path.join(stateDirectory, `${jobId}.json`);
  mkdirSync(stateDirectory, { recursive: true });
  const record = JSON.parse(readFileSync(pendingPath, "utf8"));
  writeFileSync(statePath, `${JSON.stringify({
    ...record,
    protocolVersion: 1,
    status: state,
    ...overrides,
  }, null, 2)}\n`, "utf8");
  rmSync(pendingPath, { force: true });
  return statePath;
}

function writeHealthyWorkerHeartbeat(rootDir, workerName, workerInstanceId, pid = 700) {
  const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
  const workerRoot = path.join(runtimeRoot, "workers");
  mkdirSync(workerRoot, { recursive: true });
  const environment = {
    schemaVersion: 1,
    status: "healthy",
    checkedAt: new Date().toISOString(),
    codexVersion: "test",
    runtimeFingerprint: "migration-r5-runtime",
    errors: [],
  };
  writeFileSync(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
  writeFileSync(path.join(workerRoot, `${workerName}.${workerInstanceId}.json`), JSON.stringify({
    schemaVersion: 1,
    workerName,
    workerInstanceId,
    pid,
    heartbeatAt: new Date().toISOString(),
    runtimeFingerprint: environment.runtimeFingerprint,
    status: "healthy",
    environment,
  }), "utf8");
}

function writeMigrationMapDocument(rootDir, document) {
  const directory = path.join(rootDir, ".tmp-codex-finalization-migration");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "v1-migration-map.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function runMigrationCli(rootDir, queue = "season", action = "fail") {
  return spawnSync(process.execPath, [
    path.resolve("scripts/migrate-codex-finalization-v1-jobs.mjs"),
    `--root-dir=${rootDir}`,
    `--queue=${queue}`,
    `--action=${action}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS },
  });
}

async function createActiveRequeueFixture(rootDir) {
  const season = await createSeasonPackCodexJob({
    script: "Persisted requeue intent must remain immutable.",
    episodeCount: 1,
  }, { rootDir });
  const sourcePath = markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
  const replacement = await createSeasonPackCodexJob(
    { script: season.script, episodeCount: 1 },
    { rootDir, bypassV2CreatePause: true, migrationSourceJobId: season.id },
  );
  writeMigrationMap(rootDir, {
    [`season:${season.id}`]: {
      queue: "season",
      oldJobId: season.id,
      newJobId: replacement.id,
      action: "requeue",
      migratedAt: new Date().toISOString(),
    },
  });
  return {
    season,
    replacement,
    sourcePath,
    replacementPath: path.join(rootDir, ".tmp-season-pack-codex", "pending", `${replacement.id}.json`),
  };
}

test("v1 migration defaults to dry-run and does not modify queue files", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Legacy Season pending migration input.", episodeCount: 1 }, { rootDir });
    const render = await createVideoPromptPackCodexJob({
      idempotencyKey: "legacy-render-dry-run",
      segments: [{
        episodeIndex: 1,
        title: "Legacy render",
        script: "Legacy Render pending migration input.",
        renderInputScript: "Legacy Render input remains unchanged during dry-run.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    markPendingAsV1(rootDir, ".tmp-video-prompt-pack-codex", render.id);
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir });
    assert.equal(report.action, "dry-run");
    assert.equal(report.counts.pending, 2);
    assert.equal(report.modelCalls, 0);
    assert.deepEqual(snapshotFiles(rootDir), before);
    assert.ok(report.jobs.every((job) => !job.jobId.includes(season.id) && !job.jobId.includes(render.id)));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue migration is idempotent and never calls Codex", async () => {
  const rootDir = makeTempRoot();
  const previous = process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
  try {
    const season = await createSeasonPackCodexJob({ script: "Legacy Season idempotent requeue.", episodeCount: 1 }, { rootDir });
    const render = await createVideoPromptPackCodexJob({
      idempotencyKey: "legacy-render-idempotent-requeue",
      segments: [{
        episodeIndex: 1,
        title: "Legacy render requeue",
        script: "Legacy Render idempotent requeue input.",
        renderInputScript: "Requeue one protocol v2 task without invoking Codex.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    markPendingAsV1(rootDir, ".tmp-video-prompt-pack-codex", render.id);
    process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED = "false";
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const first = await migrateCodexFinalizationV1Jobs({ rootDir, action: "requeue" });
    const second = await migrateCodexFinalizationV1Jobs({ rootDir, action: "requeue" });
    const seasonV2 = readdirSync(path.join(rootDir, ".tmp-season-pack-codex", "pending"))
      .map((name) => JSON.parse(readFileSync(path.join(rootDir, ".tmp-season-pack-codex", "pending", name), "utf8")))
      .filter((job) => job.protocolVersion === 2);
    const renderV2 = readdirSync(path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending"))
      .map((name) => JSON.parse(readFileSync(path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending", name), "utf8")))
      .filter((job) => job.protocolVersion === 2);
    assert.equal(seasonV2.length, 1);
    assert.equal(renderV2.length, 1);
    assert.equal(first.modelCalls, 0);
    assert.equal(second.modelCalls, 0);
    assert.equal(second.counts.requeued, 0);
    assert.equal(second.counts.alreadyMigrated, 2);
    assert.equal(existsSync(path.join(rootDir, ".tmp-codex-finalization-migration", "v1-migration-map.json")), true);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-video-prompt-pack-codex", render.id), 0);
    const failedSeason = readFailedJob(rootDir, ".tmp-season-pack-codex", season.id);
    const failedRender = readFailedJob(rootDir, ".tmp-video-prompt-pack-codex", render.id);
    for (const failed of [failedSeason, failedRender]) {
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "FINALIZATION_V1_REQUEUED");
      assert.equal(failed.legacyMigrationAction, "requeue");
      assert.equal(failed.legacyMigrationState, "source_terminalized");
      assert.ok(failed.replacementJobId);
      assert.ok(failed.migratedAt);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
    else process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED = previous;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue resumes after replacement creation without creating a second replacement", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Crash after replacement creation.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    await assert.rejects(
      migrateCodexFinalizationV1Jobs({
        rootDir,
        queue: "season",
        action: "requeue",
        testHooks: { afterReplacementCreated: () => { throw new Error("injected-after-replacement"); } },
      }),
      /injected-after-replacement/,
    );
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    assert.equal(report.counts.requeued, 1);
    assert.equal(report.modelCalls, 0);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue resumes after source terminalization and backfills the migration map", async () => {
  const rootDir = makeTempRoot();
  try {
    const render = await createVideoPromptPackCodexJob({
      idempotencyKey: "legacy-render-terminalization-crash",
      segments: [{
        episodeIndex: 1,
        title: "Terminalized source",
        script: "Crash after the source becomes terminal.",
        renderInputScript: "The replacement remains deterministic across recovery.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-video-prompt-pack-codex", render.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    await assert.rejects(
      migrateCodexFinalizationV1Jobs({
        rootDir,
        queue: "render",
        action: "requeue",
        testHooks: { afterSourceTerminalized: () => { throw new Error("injected-after-terminalization"); } },
      }),
      /injected-after-terminalization/,
    );
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-video-prompt-pack-codex", render.id), 0);
    assert.equal(existsSync(path.join(rootDir, ".tmp-codex-finalization-migration", "v1-migration-map.json")), false);

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "render", action: "requeue" });
    const migrationMap = JSON.parse(readFileSync(
      path.join(rootDir, ".tmp-codex-finalization-migration", "v1-migration-map.json"),
      "utf8",
    ));
    assert.equal(report.modelCalls, 0);
    assert.ok(migrationMap.entries[`render:${render.id}`]?.newJobId);
    assert.equal(countV2Jobs(rootDir, ".tmp-video-prompt-pack-codex"), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue reconciles a legacy map whose source is still active", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Map exists while source remains active.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const replacement = await createSeasonPackCodexJob(
      { script: season.script, episodeCount: 1 },
      { rootDir, bypassV2CreatePause: true, migrationSourceJobId: season.id },
    );
    writeMigrationMap(rootDir, {
      [`season:${season.id}`]: {
        queue: "season",
        oldJobId: season.id,
        newJobId: replacement.id,
        action: "requeue",
        migratedAt: new Date().toISOString(),
      },
    });
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    assert.equal(report.counts.reconciled, 1);
    assert.equal(report.modelCalls, 0);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
    assert.equal(readFailedJob(rootDir, ".tmp-season-pack-codex", season.id).replacementJobId, replacement.id);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 migration rejects requeue to fail action conflicts without changing bytes", async () => {
  const rootDir = makeTempRoot();
  try {
    const fixture = await createActiveRequeueFixture(rootDir);
    const before = {
      source: readFileSync(fixture.sourcePath, "utf8"),
      map: readMigrationMapBytes(rootDir),
      replacement: readFileSync(fixture.replacementPath, "utf8"),
    };
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.actionConflict, 1);
    assert.equal(report.counts.stateConflict, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(report.jobs[0].decision, "manual-review");
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
    assert.equal(readFileSync(fixture.sourcePath, "utf8"), before.source);
    assert.equal(readMigrationMapBytes(rootDir), before.map);
    assert.equal(readFileSync(fixture.replacementPath, "utf8"), before.replacement);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", fixture.season.id), 1);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 migration rejects fail to requeue action conflicts for active and terminal sources", async () => {
  for (const terminalized of [false, true]) {
    const rootDir = makeTempRoot();
    try {
      const season = await createSeasonPackCodexJob({
        script: `Persisted fail intent ${terminalized ? "terminal" : "active"}.`,
        episodeCount: 1,
      }, { rootDir });
      markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
      const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
      if (terminalized) {
        await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
      } else {
        writeMigrationMap(rootDir, {
          [`season:${season.id}`]: {
            queue: "season",
            oldJobId: season.id,
            newJobId: null,
            action: "fail",
            migratedAt: new Date().toISOString(),
          },
        });
      }
      const before = snapshotFiles(rootDir);

      const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

      assert.equal(report.counts.actionConflict, 1);
      assert.equal(report.counts.stateConflict, 0);
      assert.equal(report.modelCalls, 0);
      assert.equal(report.jobs[0].decision, "manual-review");
      assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
      assert.deepEqual(snapshotFiles(rootDir), before);
      assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("v1 migration rejects a source and map action state conflict without changing bytes", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Conflicting persisted migration state.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    const map = JSON.parse(readMigrationMapBytes(rootDir));
    map.entries[`season:${season.id}`].action = "fail";
    writeFileSync(migrationMapPath(rootDir), `${JSON.stringify(map, null, 2)}\n`, "utf8");
    const before = snapshotFiles(rootDir);

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.counts.actionConflict, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(report.jobs[0].decision, "manual-review");
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 migration rejects a terminal requeue to fail conflict without changing bytes", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Terminal requeue intent remains immutable.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    const before = snapshotFiles(rootDir);

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.actionConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
    assert.equal(report.modelCalls, 0);
    assert.deepEqual(snapshotFiles(rootDir), before);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 migration CLI reports action conflicts and exits nonzero", async () => {
  const rootDir = makeTempRoot();
  try {
    await createActiveRequeueFixture(rootDir);
    const result = spawnSync(process.execPath, [
      path.resolve("scripts/migrate-codex-finalization-v1-jobs.mjs"),
      `--root-dir=${rootDir}`,
      "--queue=season",
      "--action=fail",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS },
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.counts.actionConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
    assert.equal(report.modelCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue preserves the active source when the deterministic replacement identity is invalid", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Identity mismatch must be rejected.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const replacement = await createSeasonPackCodexJob(
      { script: season.script, episodeCount: 1 },
      { rootDir, bypassV2CreatePause: true, migrationSourceJobId: season.id },
    );
    const replacementPath = path.join(rootDir, ".tmp-season-pack-codex", "pending", `${replacement.id}.json`);
    writeFileSync(replacementPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(replacementPath, "utf8")),
      sourceHash: "0".repeat(64),
    }, null, 2)}\n`, "utf8");
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    assert.equal(report.counts.identityMismatch, 1);
    assert.equal(report.counts.requeued, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_IDENTITY_MISMATCH");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue preserves the active source when a legacy map points to a missing replacement", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Missing mapped replacement.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const expectedReplacementId = `season-pack-job-${createHash("sha256")
      .update(`finalization-v1:${season.id}`).digest("hex").slice(0, 32)}`;
    writeMigrationMap(rootDir, {
      [`season:${season.id}`]: {
        queue: "season",
        oldJobId: season.id,
        newJobId: expectedReplacementId,
        action: "requeue",
        migratedAt: new Date().toISOString(),
      },
    });
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });
    assert.equal(report.counts.identityMismatch, 1);
    assert.equal(report.counts.requeued, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 requeue rejects a mismatched deterministic Render replacement", async () => {
  const rootDir = makeTempRoot();
  try {
    const input = {
      idempotencyKey: "legacy-render-identity-source",
      segments: [{
        episodeIndex: 1,
        title: "Render identity",
        script: "Render replacement identity must match.",
        renderInputScript: "Do not accept a replacement with a different source hash.",
        duration: "12 seconds",
      }],
    };
    const render = await createVideoPromptPackCodexJob(input, { rootDir });
    markPendingAsV1(rootDir, ".tmp-video-prompt-pack-codex", render.id);
    const replacement = await createVideoPromptPackCodexJob({
      ...input,
      idempotencyKey: `finalization-v1:${render.id}`,
    }, { rootDir, bypassV2CreatePause: true });
    const replacementPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending", `${replacement.id}.json`);
    writeFileSync(replacementPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(replacementPath, "utf8")),
      sourceHash: "f".repeat(64),
    }, null, 2)}\n`, "utf8");
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "render", action: "requeue" });
    assert.equal(report.counts.identityMismatch, 1);
    assert.equal(report.counts.requeued, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-video-prompt-pack-codex", render.id), 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_IDENTITY_MISMATCH");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("only one v1 migration process can hold the migration singleton", async () => {
  const rootDir = makeTempRoot();
  let releaseFirst;
  let enteredFirst;
  const releaseBarrier = new Promise((resolve) => { releaseFirst = resolve; });
  const enteredBarrier = new Promise((resolve) => { enteredFirst = resolve; });
  try {
    const season = await createSeasonPackCodexJob({ script: "Migration singleton fixture.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    const first = migrateCodexFinalizationV1Jobs({
      rootDir,
      queue: "season",
      action: "requeue",
      testHooks: {
        afterLockAcquired: async () => {
          enteredFirst();
          await releaseBarrier;
        },
      },
    });
    const entered = await Promise.race([
      enteredBarrier.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(entered, true, "the exported test hook must run after the singleton is acquired");
    await assert.rejects(
      migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" }),
      /migration.*already running/i,
    );
    releaseFirst();
    const report = await first;
    assert.equal(report.modelCalls, 0);
  } finally {
    releaseFirst?.();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 running migration skips an exact healthy owner and requeues only a stale owner", async () => {
  const rootDir = makeTempRoot();
  try {
    const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    mkdirSync(workerRoot, { recursive: true });
    const environment = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      codexVersion: "test",
      runtimeFingerprint: "migration-runtime",
      errors: [],
    };
    writeFileSync(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
    writeFileSync(path.join(workerRoot, "season-pack.healthy-v1-owner.json"), JSON.stringify({
      schemaVersion: 1,
      workerName: "season-pack",
      workerInstanceId: "healthy-v1-owner",
      pid: 700,
      heartbeatAt: new Date().toISOString(),
      runtimeFingerprint: "migration-runtime",
      status: "healthy",
      environment,
    }), "utf8");
    const healthy = await createSeasonPackCodexJob({ script: "Healthy running legacy Season owner.", episodeCount: 1 }, { rootDir });
    const stale = await createSeasonPackCodexJob({ script: "Stale running legacy Season owner.", episodeCount: 1 }, { rootDir });
    for (const [job, workerId] of [[healthy, "healthy-v1-owner"], [stale, "stale-v1-owner"]]) {
      const pending = path.join(rootDir, ".tmp-season-pack-codex", "pending", `${job.id}.json`);
      const runningDir = path.join(rootDir, ".tmp-season-pack-codex", "running");
      mkdirSync(runningDir, { recursive: true });
      const record = JSON.parse(readFileSync(pending, "utf8"));
      writeFileSync(path.join(runningDir, `${job.id}.json`), `${JSON.stringify({
        ...record,
        protocolVersion: 1,
        status: "running",
        stage: "executing",
        leaseId: `lease-${workerId}`,
        workerId,
      }, null, 2)}\n`, "utf8");
      rmSync(pending, { force: true });
    }
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    const report = await migrateCodexFinalizationV1Jobs({ rootDir, action: "requeue" });

    assert.equal(report.counts.healthyRunningSkipped, 1);
    assert.equal(report.counts.requeued, 1);
    assert.equal(report.modelCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 running migration protects exact legacy PID owners and conservatively skips unverifiable owners", async () => {
  const rootDir = makeTempRoot();
  try {
    const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
    const workerRoot = path.join(runtimeRoot, "workers");
    mkdirSync(workerRoot, { recursive: true });
    const environment = {
      schemaVersion: 1,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      codexVersion: "test",
      runtimeFingerprint: "migration-legacy-runtime",
      errors: [],
    };
    writeFileSync(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
    for (const [workerName, pid] of [["season-pack", 710], ["video-prompt-pack", 810]]) {
      writeFileSync(path.join(workerRoot, `${workerName}.${pid}.json`), JSON.stringify({
        schemaVersion: 1,
        workerName,
        pid,
        heartbeatAt: new Date().toISOString(),
        runtimeFingerprint: environment.runtimeFingerprint,
        status: "healthy",
        environment,
      }), "utf8");
    }

    const season = await createSeasonPackCodexJob({ script: "Legacy PID Season owner.", episodeCount: 1 }, { rootDir });
    const render = await createVideoPromptPackCodexJob({
      idempotencyKey: "legacy-pid-render-owner",
      segments: [{
        episodeIndex: 1,
        title: "Legacy PID render",
        script: "Legacy PID Render owner.",
        renderInputScript: "The exact legacy Render worker still owns this task.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const custom = await createSeasonPackCodexJob({ script: "Unverifiable custom owner.", episodeCount: 1 }, { rootDir });
    for (const [namespace, job, workerId] of [
      [".tmp-season-pack-codex", season, "season-pack-710"],
      [".tmp-video-prompt-pack-codex", render, "video-prompt-pack-810"],
      [".tmp-season-pack-codex", custom, "legacy-custom-owner"],
    ]) {
      const pending = path.join(rootDir, namespace, "pending", `${job.id}.json`);
      const runningDir = path.join(rootDir, namespace, "running");
      mkdirSync(runningDir, { recursive: true });
      const record = JSON.parse(readFileSync(pending, "utf8"));
      writeFileSync(path.join(runningDir, `${job.id}.json`), `${JSON.stringify({
        ...record,
        protocolVersion: 1,
        status: "running",
        stage: "executing",
        leaseId: `lease-${workerId}`,
        workerId,
      }, null, 2)}\n`, "utf8");
      rmSync(pending, { force: true });
    }

    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    const report = await migrateCodexFinalizationV1Jobs({ rootDir, action: "requeue" });

    assert.equal(report.counts.healthyRunningSkipped, 2);
    assert.equal(report.counts.unverifiableOwnerSkipped, 1);
    assert.equal(report.counts.requeued, 0);
    assert.equal(report.modelCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 fail migration is explicit, idempotent, and never calls Codex", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({
      script: "Legacy pending Season job is explicitly failed by an operator.",
      episodeCount: 1,
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const first = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    const second = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    const failedPath = path.join(rootDir, ".tmp-season-pack-codex", "failed", `${season.id}.json`);
    const failed = JSON.parse(readFileSync(failedPath, "utf8"));

    assert.equal(first.counts.failedByMigration, 1);
    assert.equal(first.modelCalls, 0);
    assert.equal(second.counts.failedByMigration, 0);
    assert.equal(second.counts.alreadyMigrated, 1);
    assert.equal(second.modelCalls, 0);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "FINALIZATION_V1_MIGRATED_FAILED");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 fail migration reconciles an existing fail map whose source is still active", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({
      script: "Fail recovery must terminalize an active source.",
      episodeCount: 1,
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMap(rootDir, {
      [`season:${season.id}`]: {
        queue: "season",
        oldJobId: season.id,
        newJobId: null,
        action: "fail",
        migratedAt: new Date().toISOString(),
      },
    });
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    const failed = readFailedJob(rootDir, ".tmp-season-pack-codex", season.id);
    const map = JSON.parse(readMigrationMapBytes(rootDir));

    assert.equal(report.counts.reconciled, 1);
    assert.equal(report.counts.alreadyMigrated, 0);
    assert.equal(report.modelCalls, 0);
    assert.equal(report.jobs[0].decision, "reconciled");
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);
    assert.equal(failed.errorCode, "FINALIZATION_V1_MIGRATED_FAILED");
    assert.equal(failed.legacyMigrationAction, "fail");
    assert.equal(failed.replacementJobId, null);
    assert.equal(map.entries[`season:${season.id}`].action, "fail");
    assert.equal(map.entries[`season:${season.id}`].newJobId, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 fail migration backfills a missing map and is byte-idempotent afterward", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({
      script: "Fail recovery backfills a missing map without rewriting source.",
      episodeCount: 1,
    }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();
    await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    rmSync(migrationMapPath(rootDir), { force: true });
    const failedPath = path.join(rootDir, ".tmp-season-pack-codex", "failed", `${season.id}.json`);
    const sourceBeforeBackfill = readFileSync(failedPath, "utf8");

    const reconciled = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    assert.equal(reconciled.counts.reconciled, 1);
    assert.equal(reconciled.jobs[0].decision, "reconciled");
    assert.equal(reconciled.modelCalls, 0);
    assert.equal(readFileSync(failedPath, "utf8"), sourceBeforeBackfill);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 0);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);

    const beforeReplay = snapshotFiles(rootDir);
    const replay = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    assert.equal(replay.counts.alreadyMigrated, 1);
    assert.equal(replay.jobs[0].decision, "already-migrated");
    assert.equal(replay.modelCalls, 0);
    assert.deepEqual(snapshotFiles(rootDir), beforeReplay);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight rejects a fail map missing newJobId before mutating its active source", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Synthetic missing fail identity.", episodeCount: 1 }, { rootDir });
    const sourcePath = markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMap(rootDir, {
      [`season:${season.id}`]: {
        queue: "season",
        oldJobId: season.id,
        action: "fail",
        migratedAt: new Date().toISOString(),
      },
    });
    const before = { source: readFileSync(sourcePath, "utf8"), map: readMigrationMapBytes(rootDir) };
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.jobs[0].decision, "manual-review");
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.equal(readFileSync(sourcePath, "utf8"), before.source);
    assert.equal(readMigrationMapBytes(rootDir), before.map);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
    assert.equal(existsSync(path.join(rootDir, ".tmp-season-pack-codex", "failed", `${season.id}.json`)), false);

    const cli = spawnSync(process.execPath, [
      path.resolve("scripts/migrate-codex-finalization-v1-jobs.mjs"),
      `--root-dir=${rootDir}`,
      "--queue=season",
      "--action=fail",
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS } });
    assert.notEqual(cli.status, 0);
    assert.equal(JSON.parse(cli.stdout).jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.equal(readFileSync(sourcePath, "utf8"), before.source);
    assert.equal(readMigrationMapBytes(rootDir), before.map);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight reports action conflict before a healthy running owner skip", async () => {
  const rootDir = makeTempRoot();
  try {
    const fixture = await createActiveRequeueFixture(rootDir);
    writeHealthyWorkerHeartbeat(rootDir, "season-pack", "healthy-r5-owner");
    const runningPath = movePendingV1ToState(rootDir, ".tmp-season-pack-codex", fixture.season.id, "running", {
      stage: "executing",
      leaseId: "lease-healthy-r5-owner",
      workerId: "healthy-r5-owner",
    });
    const before = {
      source: readFileSync(runningPath, "utf8"),
      map: readMigrationMapBytes(rootDir),
      replacement: readFileSync(fixture.replacementPath, "utf8"),
    };
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.actionConflict, 1);
    assert.equal(report.counts.healthyRunningSkipped, 0);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
    assert.equal(readFileSync(runningPath, "utf8"), before.source);
    assert.equal(readMigrationMapBytes(rootDir), before.map);
    assert.equal(readFileSync(fixture.replacementPath, "utf8"), before.replacement);
    const cli = spawnSync(process.execPath, [
      path.resolve("scripts/migrate-codex-finalization-v1-jobs.mjs"),
      `--root-dir=${rootDir}`,
      "--queue=season",
      "--action=fail",
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS } });
    assert.notEqual(cli.status, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight reports action conflict before skipping a terminal source without audit", async () => {
  const rootDir = makeTempRoot();
  try {
    const fixture = await createActiveRequeueFixture(rootDir);
    const failedPath = movePendingV1ToState(rootDir, ".tmp-season-pack-codex", fixture.season.id, "failed", {
      errorCode: "LEGACY_FAILURE",
      error: "Synthetic terminal source without migration audit.",
    });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.actionConflict, 1);
    assert.equal(report.counts.terminalSkipped, 0);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_ACTION_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
    assert.ok(existsSync(failedPath));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight rejects a same-action map on a terminal source without migration audit", async () => {
  const rootDir = makeTempRoot();
  try {
    const fixture = await createActiveRequeueFixture(rootDir);
    movePendingV1ToState(rootDir, ".tmp-season-pack-codex", fixture.season.id, "completed", {
      result: { synthetic: true },
    });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.counts.terminalSkipped, 0);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight preserves ordinary terminal jobs without map or migration audit", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Ordinary terminal legacy source.", episodeCount: 1 }, { rootDir });
    movePendingV1ToState(rootDir, ".tmp-season-pack-codex", season.id, "failed", { errorCode: "LEGACY_FAILURE" });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

    assert.equal(report.counts.terminalSkipped, 1);
    assert.equal(report.counts.stateConflict, 0);
    assert.equal(report.counts.actionConflict, 0);
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight keeps healthy owner protection after validating a matching action", async () => {
  const rootDir = makeTempRoot();
  try {
    const fixture = await createActiveRequeueFixture(rootDir);
    writeHealthyWorkerHeartbeat(rootDir, "season-pack", "healthy-r5-same-action");
    movePendingV1ToState(rootDir, ".tmp-season-pack-codex", fixture.season.id, "running", {
      stage: "executing",
      leaseId: "lease-healthy-r5-same-action",
      workerId: "healthy-r5-same-action",
    });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

    assert.equal(report.counts.healthyRunningSkipped, 1);
    assert.equal(report.counts.actionConflict, 0);
    assert.equal(report.counts.stateConflict, 0);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 1);
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 preflight rejects migration map queue and source identity mismatches without mutation", async () => {
  for (const mutation of ["queue", "oldJobId"]) {
    const rootDir = makeTempRoot();
    try {
      const season = await createSeasonPackCodexJob({ script: `Invalid migration map ${mutation}.`, episodeCount: 1 }, { rootDir });
      markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
      writeMigrationMap(rootDir, {
        [`season:${season.id}`]: {
          queue: mutation === "queue" ? "render" : "season",
          oldJobId: mutation === "oldJobId" ? "different-source" : season.id,
          newJobId: null,
          action: "fail",
          migratedAt: new Date().toISOString(),
        },
      });
      const before = snapshotFiles(rootDir);
      const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

      const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

      assert.equal(report.counts.stateConflict, 1);
      assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
      assert.deepEqual(snapshotFiles(rootDir), before);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("v1 preflight rejects partial source migration audit without mutation", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Partial source audit.", episodeCount: 1 }, { rootDir });
    const sourcePath = markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    writeFileSync(sourcePath, `${JSON.stringify({
      ...source,
      legacyMigrationAction: "requeue",
      replacementJobId: `season-pack-job-${createHash("sha256")
        .update(`finalization-v1:${season.id}`).digest("hex").slice(0, 32)}`,
    }, null, 2)}\n`, "utf8");
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "requeue" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 dry-run reports malformed persisted state without mutating files", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Dry-run static preflight.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMap(rootDir, {
      [`season:${season.id}`]: {
        queue: "season",
        oldJobId: season.id,
        action: "fail",
        migratedAt: new Date().toISOString(),
      },
    });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "dry-run" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 map integrity rejects a present null entry before any mutation", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Null map entry must fail closed.", episodeCount: 1 }, { rootDir });
    const sourcePath = markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMap(rootDir, { [`season:${season.id}`]: null });
    const before = snapshotFiles(rootDir);
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const mapBefore = readMigrationMapBytes(rootDir);
    const replacementsBefore = countV2Jobs(rootDir, ".tmp-season-pack-codex");
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore);
    assert.equal(readMigrationMapBytes(rootDir), mapBefore);
    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), replacementsBefore);
    assert.equal(existsSync(path.join(rootDir, ".tmp-season-pack-codex", "failed", `${season.id}.json`)), false);
    assert.deepEqual(snapshotFiles(rootDir), before);

    const cli = runMigrationCli(rootDir);
    assert.notEqual(cli.status, 0);
    assert.equal(JSON.parse(cli.stdout).jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 map integrity rejects a present null entry during dry-run", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Dry-run must expose null map entries.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMap(rootDir, { [`season:${season.id}`]: null });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "dry-run" });

    assert.equal(report.counts.stateConflict, 1);
    assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 map integrity rejects every present non-object entry shape without mutation", async () => {
  for (const entryValue of [null, [], "invalid", 0, false]) {
    const rootDir = makeTempRoot();
    try {
      const season = await createSeasonPackCodexJob({ script: "Non-object map entries must fail closed.", episodeCount: 1 }, { rootDir });
      markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
      writeMigrationMap(rootDir, { [`season:${season.id}`]: entryValue });
      const before = snapshotFiles(rootDir);
      const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

      const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

      assert.equal(report.counts.stateConflict, 1, `entry ${JSON.stringify(entryValue)} must conflict`);
      assert.equal(report.jobs[0].errorCode, "FINALIZATION_V1_MIGRATION_STATE_CONFLICT");
      assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
      assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);
      assert.deepEqual(snapshotFiles(rootDir), before);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("v1 map integrity rejects an entries array root before terminalizing an active source", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "Array entries roots must fail closed.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    writeMigrationMapDocument(rootDir, { schemaVersion: 1, updatedAt: null, entries: [] });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    await assert.rejects(
      migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" }),
      (error) => error?.code === "FINALIZATION_V1_MIGRATION_STATE_CONFLICT",
    );

    assert.equal(countActiveV1Jobs(rootDir, ".tmp-season-pack-codex", season.id), 1);
    assert.equal(countV2Jobs(rootDir, ".tmp-season-pack-codex"), 0);
    assert.equal(existsSync(path.join(rootDir, ".tmp-season-pack-codex", "failed", `${season.id}.json`)), false);
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 map integrity rejects invalid root documents even when no legacy jobs exist", async () => {
  const invalidRoots = [
    null,
    [],
    { schemaVersion: 2, entries: {} },
    { schemaVersion: 1 },
    { schemaVersion: 1, entries: null },
    { schemaVersion: 1, entries: "invalid" },
  ];

  for (const document of invalidRoots) {
    const rootDir = makeTempRoot();
    try {
      writeMigrationMapDocument(rootDir, document);
      const before = snapshotFiles(rootDir);
      const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

      await assert.rejects(
        migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" }),
        (error) => error?.code === "FINALIZATION_V1_MIGRATION_STATE_CONFLICT",
        `root ${JSON.stringify(document)} must reject`,
      );
      assert.deepEqual(snapshotFiles(rootDir), before);

      const cli = runMigrationCli(rootDir);
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr, /FINALIZATION_V1_MIGRATION_STATE_CONFLICT/);
      assert.deepEqual(snapshotFiles(rootDir), before);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("v1 map integrity accepts a valid empty map document", async () => {
  const rootDir = makeTempRoot();
  try {
    writeMigrationMapDocument(rootDir, { schemaVersion: 1, entries: {} });
    const before = snapshotFiles(rootDir);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });

    assert.equal(report.counts.stateConflict, 0);
    assert.equal(report.jobs.length, 0);
    assert.deepEqual(snapshotFiles(rootDir), before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v1 map integrity still creates the first legal map after ENOENT", async () => {
  const rootDir = makeTempRoot();
  try {
    const season = await createSeasonPackCodexJob({ script: "A missing map remains a valid first migration.", episodeCount: 1 }, { rootDir });
    markPendingAsV1(rootDir, ".tmp-season-pack-codex", season.id);
    const { migrateCodexFinalizationV1Jobs } = await loadMigrationModule();

    const report = await migrateCodexFinalizationV1Jobs({ rootDir, queue: "season", action: "fail" });
    const document = JSON.parse(readMigrationMapBytes(rootDir));

    assert.equal(report.counts.failedByMigration, 1);
    assert.equal(document.schemaVersion, 1);
    assert.ok(document.entries && !Array.isArray(document.entries));
    assert.equal(document.entries[`season:${season.id}`].action, "fail");
    assert.equal(document.entries[`season:${season.id}`].newJobId, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
