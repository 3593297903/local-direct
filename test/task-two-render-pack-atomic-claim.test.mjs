import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
  claimNextVideoPromptPackCodexJob,
  completeVideoPromptPackCodexJob,
  createVideoPromptPackCodexJob,
  getVideoPromptPackCodexJob,
} = require("../lib/video-prompt-pack-codex-queue.ts");
const {
  claimNextFileJob,
  finishRunningFileJob,
  putPendingFileJob,
} = require("../lib/file-job-store.ts");

test("render pack create is idempotent and twenty concurrent claims produce one fenced lease", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-render-claim-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const input = {
    idempotencyKey: "batch-20:wave-1:segments-1-2",
    segments: [{
      episodeIndex: 1,
      title: "Segment 1",
      script: "Long enough source text for segment one.",
      renderInputScript: "Render complete segment one video prompt.",
      duration: "12 seconds",
      shotCount: 4,
    }],
  };
  try {
    const creates = await Promise.all(Array.from({ length: 20 }, () =>
      createVideoPromptPackCodexJob(input, { rootDir })));
    const first = creates[0];
    assert.equal(new Set(creates.map((job) => job.id)).size, 1);
    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      claimNextVideoPromptPackCodexJob({ rootDir, workerId: `worker-${index}` })));
    const successful = claims.filter(Boolean);
    assert.equal(successful.length, 1);
    assert.match(successful[0].leaseId, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof successful[0].fencingToken, "number");
    assert.equal(successful[0].attempt, 1);
    await assert.rejects(
      () => completeVideoPromptPackCodexJob(
        successful[0].id,
        successful[0].leaseId,
        successful[0].fencingToken + 1,
        { rootDir },
      ),
      /lease|fencing/i,
    );

    const runningPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "running", `${successful[0].id}.json`);
    const stale = JSON.parse(readFileSync(runningPath, "utf8"));
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(runningPath, JSON.stringify({
      ...stale,
      heartbeatAt: staleAt,
      startedAt: staleAt,
      updatedAt: staleAt,
    }, null, 2));
    const reclaimed = await claimNextVideoPromptPackCodexJob({
      rootDir,
      workerId: "worker-recovery",
      runningTimeoutMs: 1,
    });
    assert.equal(reclaimed.id, successful[0].id);
    assert.notEqual(reclaimed.leaseId, successful[0].leaseId);
    assert.equal(reclaimed.fencingToken, successful[0].fencingToken + 1);
    await assert.rejects(
      () => completeVideoPromptPackCodexJob(
        successful[0].id,
        successful[0].leaseId,
        successful[0].fencingToken,
        { rootDir },
      ),
      /lease|fencing/i,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a recovered file job rejects completion from the stale fenced lease", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-fencing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const namespace = ".tmp-fencing-test";
  const now = new Date().toISOString();
  try {
    await putPendingFileJob(rootDir, namespace, {
      id: "fenced-job",
      status: "pending",
      leaseId: null,
      workerId: null,
      attempt: 0,
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
    });
    const first = await claimNextFileJob(rootDir, namespace, { workerId: "worker-first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await claimNextFileJob(rootDir, namespace, {
      workerId: "worker-second",
      runningTimeoutMs: 1,
      canRecoverRunningJob: () => true,
    });
    assert.notEqual(second.leaseId, first.leaseId);
    assert.equal(second.fencingToken, first.fencingToken + 1);
    await assert.rejects(
      () => finishRunningFileJob(rootDir, namespace, first, "completed"),
      /lease|fencing/i,
    );
    const completed = await finishRunningFileJob(rootDir, namespace, second, "completed");
    assert.equal(completed.status, "completed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a claim lease write EPERM rolls the moved job back so exactly one later claim can execute it", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-claim-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const namespace = ".tmp-claim-rollback-test";
  const now = new Date().toISOString();
  try {
    await putPendingFileJob(rootDir, namespace, {
      id: "rollback-job",
      status: "pending",
      leaseId: null,
      workerId: null,
      attempt: 0,
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
    });
    await assert.rejects(
      () => claimNextFileJob(rootDir, namespace, {
        workerId: "worker-failing-lease-write",
        claimLeaseWriteOptions: {
          retryDelaysMs: [0],
          renameImpl: async () => {
            const error = new Error("simulated sharing violation");
            error.code = "EPERM";
            throw error;
          },
        },
      }),
      (error) => error?.code === "JOB_STORAGE_BUSY",
    );

    const pendingPath = path.join(rootDir, namespace, "pending", "rollback-job.json");
    const runningPath = path.join(rootDir, namespace, "running", "rollback-job.json");
    assert.equal(existsSync(pendingPath), true);
    assert.equal(existsSync(runningPath), false);

    const laterClaims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      claimNextFileJob(rootDir, namespace, { workerId: `worker-retry-${index}` })));
    const executableClaims = laterClaims.filter(Boolean);
    assert.equal(executableClaims.length, 1);
    assert.equal(executableClaims[0].id, "rollback-job");
    assert.equal(executableClaims[0].attempt, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("malformed jobs in running recover regardless of timeout or global worker health", async () => {
  const cases = [
    { namespace: ".tmp-invalid-running-status", status: "pending", leaseId: null },
    { namespace: ".tmp-invalid-running-lease", status: "running", leaseId: null },
  ];
  for (const [index, scenario] of cases.entries()) {
    const rootDir = path.join(os.tmpdir(), `localdirector-invalid-running-${index}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const now = new Date().toISOString();
    try {
      const id = `invalid-running-${index}`;
      await putPendingFileJob(rootDir, scenario.namespace, {
        id,
        status: "pending",
        leaseId: null,
        workerId: null,
        attempt: 0,
        fencingToken: 0,
        createdAt: now,
        updatedAt: now,
      });
      const pendingPath = path.join(rootDir, scenario.namespace, "pending", `${id}.json`);
      const runningPath = path.join(rootDir, scenario.namespace, "running", `${id}.json`);
      const malformed = JSON.parse(readFileSync(pendingPath, "utf8"));
      writeFileSync(pendingPath, JSON.stringify({
        ...malformed,
        status: scenario.status,
        leaseId: scenario.leaseId,
        workerId: "healthy-global-worker",
        heartbeatAt: now,
      }, null, 2));
      renameSync(pendingPath, runningPath);

      const reclaimed = await claimNextFileJob(rootDir, scenario.namespace, {
        workerId: "worker-reclaimer",
        runningTimeoutMs: 60 * 60_000,
        canRecoverRunningJob: () => false,
      });
      assert.equal(reclaimed?.id, id);
      assert.equal(reclaimed?.status, "running");
      assert.ok(reclaimed?.leaseId);
      assert.equal(reclaimed?.attempt, 1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("legacy running Render Pack GET is read-only without automatic re-execution", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-render-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const created = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Legacy segment",
        script: "Legacy source text for migration coverage.",
        renderInputScript: "Legacy render input that must not execute again.",
        duration: "12 seconds",
        shotCount: 4,
      }],
    }, { rootDir });
    const taskRoot = path.join(rootDir, ".tmp-video-prompt-pack-codex");
    const pendingPath = path.join(taskRoot, "pending", `${created.id}.json`);
    const legacyDir = path.join(taskRoot, "jobs");
    const legacyPath = path.join(legacyDir, `${created.id}.json`);
    const legacy = JSON.parse(readFileSync(pendingPath, "utf8"));
    legacy.status = "running";
    legacy.leaseId = "legacy-lease";
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(pendingPath, JSON.stringify(legacy), "utf8");
    renameSync(pendingPath, legacyPath);

    const before = readFileSync(legacyPath, "utf8");
    const observed = await getVideoPromptPackCodexJob(created.id, { rootDir });
    assert.equal(observed.status, "running");
    assert.equal(observed.resultAvailable, false);
    assert.equal(readFileSync(legacyPath, "utf8"), before);
    assert.equal(existsSync(path.join(taskRoot, "failed", `${created.id}.json`)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the queue rollback switch pauses only new Render Pack and Repair claims", () => {
  for (const routePath of [
    "app/api/video-prompt-packs/jobs/claim/route.ts",
    "app/api/batch-segment-repair/jobs/claim/route.ts",
  ]) {
    const source = readFileSync(path.join(process.cwd(), routePath), "utf8");
    assert.match(source, /CODEX_FILE_QUEUE_CLAIMS_PAUSED/);
    assert.match(source, /task:\s*null/);
    assert.match(source, /claimsPaused:\s*true/);
  }
});
