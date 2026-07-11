import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";

test("worker fleet singleton lock reuses a healthy owner and recovers a stale owner", async () => {
  const { acquireWorkerFleetLock } = await import("../scripts/worker-singleton-lock.mjs");
  const rootDir = path.join(os.tmpdir(), `localdirector-worker-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const first = await acquireWorkerFleetLock("render-pack", { rootDir, pid: 123, startTime: 100, isProcessAlive: () => true });
    assert.equal(first.acquired, true);
    const duplicate = await acquireWorkerFleetLock("render-pack", { rootDir, pid: 456, startTime: 200, isProcessAlive: () => true });
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.owner.pid, 123);
    const recovered = await acquireWorkerFleetLock("render-pack", { rootDir, pid: 456, startTime: 200, isProcessAlive: () => false });
    assert.equal(recovered.acquired, true);
    await recovered.release();
    await first.release();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("worker singleton recovers a reused Windows PID when the process start time changed", async () => {
  const { acquireWorkerFleetLock } = await import("../scripts/worker-singleton-lock.mjs");
  const rootDir = path.join(os.tmpdir(), `localdirector-worker-pid-reuse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const first = await acquireWorkerFleetLock("render-pack", {
      rootDir,
      pid: 321,
      startTime: 100,
      isProcessAlive: () => true,
    });
    const recovered = await acquireWorkerFleetLock("render-pack", {
      rootDir,
      pid: 321,
      startTime: 999,
      isProcessAlive: (_pid, recordedStartTime) => recordedStartTime === 999,
    });
    assert.equal(recovered.acquired, true);
    assert.equal(recovered.owner.startTime, 999);
    await recovered.release();
    await first.release();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("twenty simultaneous worker starts elect exactly one singleton owner", async () => {
  const { acquireWorkerFleetLock } = await import("../scripts/worker-singleton-lock.mjs");
  const rootDir = path.join(os.tmpdir(), `localdirector-worker-concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      acquireWorkerFleetLock("render-pack", {
        rootDir,
        pid: 1_000 + index,
        startTime: 10_000 + index,
        isProcessAlive: () => true,
      })));
    assert.equal(attempts.filter((attempt) => attempt.acquired).length, 1);
    const ownerLeaseIds = new Set(attempts.map((attempt) => attempt.owner?.leaseId).filter(Boolean));
    assert.equal(ownerLeaseIds.size, 1);
    await Promise.all(attempts.map((attempt) => attempt.release()));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("worker fleet lock rejects a reused Windows pid with a different start time", async () => {
  const { acquireWorkerFleetLock } = await import("../scripts/worker-singleton-lock.mjs");
  const rootDir = path.join(os.tmpdir(), `localdirector-worker-pid-reuse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const first = await acquireWorkerFleetLock("render-pack", {
      rootDir,
      pid: 123,
      startTime: 100,
      isProcessAlive: (_pid, expectedStartTime) => expectedStartTime === 100,
    });
    assert.equal(first.acquired, true);
    const reused = await acquireWorkerFleetLock("render-pack", {
      rootDir,
      pid: 123,
      startTime: 200,
      isProcessAlive: (_pid, expectedStartTime) => expectedStartTime === 200,
    });
    assert.equal(reused.acquired, true);
    assert.equal(reused.owner.startTime, 200);
    await reused.release();
    await first.release();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("each Codex worker class admits only one live instance", async () => {
  const { acquireWorkerFleetLock } = await import("../scripts/worker-singleton-lock.mjs");
  const rootDir = path.join(os.tmpdir(), `localdirector-worker-classes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workerNames = [
    "season-pack-worker",
    "video-prompt-worker",
    "event-coverage-worker",
    "prompt-safety-worker",
    "storyboard-worker",
    "visual-asset-worker",
    "video-prompt-pack-worker",
    "batch-segment-repair-worker",
  ];
  try {
    for (const [index, workerName] of workerNames.entries()) {
      const first = await acquireWorkerFleetLock(workerName, {
        rootDir,
        pid: 2_000 + index,
        startTime: 20_000 + index,
        isProcessAlive: () => true,
      });
      const duplicate = await acquireWorkerFleetLock(workerName, {
        rootDir,
        pid: 3_000 + index,
        startTime: 30_000 + index,
        isProcessAlive: () => true,
      });
      assert.equal(first.acquired, true, workerName);
      assert.equal(duplicate.acquired, false, workerName);
      assert.equal(duplicate.owner.leaseId, first.owner.leaseId, workerName);
      await first.release();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
