import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const { createSeasonPackCodexJob } = require("../lib/season-pack-codex-queue.ts");
const { createVideoPromptPackCodexJob } = require("../lib/video-prompt-pack-codex-queue.ts");

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
  } finally {
    if (previous === undefined) delete process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
    else process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED = previous;
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
