import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { withAuthoritativeRenderPackInput } from "./helpers/authoritative-render-pack-fixture.mjs";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
  claimNextVideoPromptPackCodexJob,
  completeVideoPromptPackCodexJob,
  createVideoPromptPackCodexJob: createRawVideoPromptPackCodexJob,
  getVideoPromptPackCodexJob,
} = require("../lib/video-prompt-pack-codex-queue.ts");
const { normalizeSegmentContract } = require("../lib/batch-segment-contract.ts");
const { compileSegmentContractForPrompt } = require("../lib/codex-prompt-input-compiler.ts");
const {
  claimNextFileJob,
  finishRunningFileJob,
  putPendingFileJob,
} = require("../lib/file-job-store.ts");

async function createVideoPromptPackCodexJob(input, options) {
  return createRawVideoPromptPackCodexJob(
    withAuthoritativeRenderPackInput(input, {
      normalizeSegmentContract,
      compileSegmentContractForPrompt,
    }),
    options,
  );
}

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
    const originalInput = structuredClone(input);
    const adaptedOnce = withAuthoritativeRenderPackInput(input, {
      normalizeSegmentContract,
      compileSegmentContractForPrompt,
    });
    const adaptedTwice = withAuthoritativeRenderPackInput(input, {
      normalizeSegmentContract,
      compileSegmentContractForPrompt,
    });
    assert.deepEqual(input, originalInput);
    assert.deepEqual(adaptedOnce, adaptedTwice);
    await assert.rejects(
      () => createRawVideoPromptPackCodexJob(input, { rootDir }),
      (error) => error?.code === "CONTRACT_PREFLIGHT_REQUIRED",
    );
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

test("vanished pending candidate is skipped when another claimant wins between readdir and read", () => {
  const scriptPath = path.join(os.tmpdir(), `localdirector-vanished-candidate-${process.pid}-${Date.now()}.cjs`);
  const script = String.raw`
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const fsPromises = require("node:fs/promises");
const Module = require("node:module");

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
require(process.cwd() + "/node_modules/ts-node/register/transpile-only");

const originalReadFile = fsPromises.readFile;
const originalLoad = Module._load;
const rootDir = path.join(os.tmpdir(), "localdirector-vanished-claim-" + Date.now() + "-" + Math.random().toString(16).slice(2));
const namespace = ".tmp-vanished-candidate-test";
const id = "vanished-job";
const pendingPath = path.resolve(rootDir, namespace, "pending", id + ".json");
const pendingSuffix = path.normalize(path.join(namespace, "pending", id + ".json")).toLowerCase();
let firstTargetRead = true;
let interceptedTargetRead = false;
let releaseSlowRead;
let slowReadStarted;
const releaseSlowReadPromise = new Promise((resolve) => { releaseSlowRead = resolve; });
const slowReadStartedPromise = new Promise((resolve) => { slowReadStarted = resolve; });

const patchedReadFile = async (...args) => {
  const target = path.resolve(String(args[0]));
  if (target.toLowerCase().endsWith(pendingSuffix) && firstTargetRead) {
    firstTargetRead = false;
    interceptedTargetRead = true;
    slowReadStarted();
    await releaseSlowReadPromise;
    const error = new Error("simulated pending candidate vanished");
    error.code = "ENOENT";
    error.path = target;
    throw error;
  }
  return originalReadFile(...args);
};
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === "node:fs/promises") {
    return { ...fsPromises, readFile: patchedReadFile };
  }
  return originalLoad.apply(this, arguments);
};

(async () => {
  const {
    claimNextFileJob,
    putPendingFileJob,
  } = require(process.cwd() + "/lib/file-job-store.ts");
  try {
    const now = new Date().toISOString();
    await putPendingFileJob(rootDir, namespace, {
      id,
      status: "pending",
      leaseId: null,
      workerId: null,
      attempt: 0,
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
    });
    const slowClaim = claimNextFileJob(rootDir, namespace, { workerId: "worker-slow" });
    await slowReadStartedPromise;
    assert.equal(interceptedTargetRead, true);
    const fastClaim = await claimNextFileJob(rootDir, namespace, { workerId: "worker-fast" });
    assert.equal(fastClaim.id, id);
    assert.equal(fastClaim.status, "running");
    assert.ok(fastClaim.leaseId);
    assert.equal(fastClaim.attempt, 1);
    assert.equal(fastClaim.fencingToken, 1);
    releaseSlowRead();
    const slowResult = await slowClaim;
    assert.equal(slowResult, null);
    const runningPath = path.join(rootDir, namespace, "running", id + ".json");
    assert.equal(existsSync(runningPath), true);
    assert.equal(existsSync(pendingPath), false);
    const running = JSON.parse(readFileSync(runningPath, "utf8"));
    assert.equal(running.id, id);
    assert.equal(running.workerId, "worker-fast");
    assert.equal(running.fencingToken, 1);
  } finally {
    Module._load = originalLoad;
    releaseSlowRead();
    rmSync(rootDir, { recursive: true, force: true });
  }
})().catch((error) => {
  try {
    Module._load = originalLoad;
    releaseSlowRead();
    rmSync(rootDir, { recursive: true, force: true });
  } catch {}
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
`;
  try {
    writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(scriptPath, { force: true });
  }
});

test("malformed pending JSON remains a hard claim failure", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-malformed-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const namespace = ".tmp-malformed-pending-test";
  const now = new Date().toISOString();
  try {
    await putPendingFileJob(rootDir, namespace, {
      id: "malformed-job",
      status: "pending",
      leaseId: null,
      workerId: null,
      attempt: 0,
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
    });
    const pendingPath = path.join(rootDir, namespace, "pending", "malformed-job.json");
    writeFileSync(pendingPath, "{ malformed json", "utf8");
    await assert.rejects(
      () => claimNextFileJob(rootDir, namespace, { workerId: "worker-malformed" }),
      SyntaxError,
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
