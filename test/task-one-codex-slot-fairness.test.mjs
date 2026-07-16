import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_SLOT_TASK_CLASSES,
  selectCodexSlotGrants,
} from "../scripts/codex-cli-slot-policy.mjs";

function waiter(waiterId, taskClass, requestedAt) {
  return { waiterId, taskClass, requestedAt, pid: 100 };
}

function lease(leaseId, taskClass, slotNumber) {
  return { leaseId, taskClass, slotNumber, pid: 100 };
}

test("fair allocator grants the oldest eligible waiters and never exceeds four slots", () => {
  const waiters = Array.from({ length: 100 }, (_, index) =>
    waiter(`render-${String(index).padStart(3, "0")}`, "render_pack", new Date(index * 10).toISOString()));
  const grants = selectCodexSlotGrants({ waiters, leases: [], maxSlots: 4 });

  assert.deepEqual(grants.map((entry) => entry.waiterId), ["render-000", "render-001", "render-002", "render-003"]);
  assert.equal(grants.length, 4);
  assert.deepEqual(grants.map((entry) => entry.slotNumber), [1, 2, 3, 4]);
});

test("an earlier render waiter cannot be overtaken by later corrective work", () => {
  const waiters = [
    waiter("render-old", "render_pack", "2026-01-01T00:00:00.000Z"),
    ...Array.from({ length: 5 }, (_, index) =>
      waiter(`repair-${index}`, "single_generation", `2026-01-01T00:00:0${index + 1}.000Z`)),
  ];
  const grants = selectCodexSlotGrants({ waiters, leases: [], maxSlots: 4 });

  assert.equal(grants[0]?.waiterId, "render-old");
  assert.equal(grants.filter((entry) => entry.taskClass !== "render_pack").length <= 1, true);
});

test("original-video demand limits corrective and background admission to one slot without starving it", () => {
  const grants = selectCodexSlotGrants({
    waiters: [
      waiter("repair-old", "path_repair", "2026-01-01T00:00:00.000Z"),
      waiter("render-1", "render_pack", "2026-01-01T00:00:01.000Z"),
      waiter("render-2", "render_pack", "2026-01-01T00:00:02.000Z"),
      waiter("render-3", "render_pack", "2026-01-01T00:00:03.000Z"),
      waiter("asset", "visual_asset", "2026-01-01T00:00:04.000Z"),
    ],
    leases: [],
    maxSlots: 4,
  });

  assert.equal(grants[0]?.waiterId, "repair-old");
  assert.equal(grants.filter((entry) => !["season_pack", "render_pack"].includes(entry.taskClass)).length, 1);
  assert.deepEqual(grants.slice(1).map((entry) => entry.waiterId), ["render-1", "render-2", "render-3"]);
});

test("an active render lease keeps new non-original admissions capped at one", () => {
  const grants = selectCodexSlotGrants({
    waiters: [
      waiter("repair-1", "path_repair", "2026-01-01T00:00:00.000Z"),
      waiter("repair-2", "coverage_judge", "2026-01-01T00:00:01.000Z"),
      waiter("asset", "visual_asset", "2026-01-01T00:00:02.000Z"),
    ],
    leases: [lease("render-active", "render_pack", 1)],
    maxSlots: 4,
  });

  assert.deepEqual(grants.map((entry) => entry.waiterId), ["repair-1"]);
});

test("1000 deterministic rounds grant every continuously eligible waiter", () => {
  let pending = [
    waiter("repair-sentinel", "path_repair", "2026-01-01T00:00:00.000Z"),
    ...Array.from({ length: 999 }, (_, index) =>
      waiter(`render-${index}`, "render_pack", new Date(1_000 + index).toISOString())),
  ];
  const granted = new Set();

  for (let round = 0; round < 1_000 && pending.length > 0; round += 1) {
    const grants = selectCodexSlotGrants({ waiters: pending, leases: [], maxSlots: 4 });
    for (const entry of grants) granted.add(entry.waiterId);
    const ids = new Set(grants.map((entry) => entry.waiterId));
    pending = pending.filter((entry) => !ids.has(entry.waiterId));
  }

  assert.equal(granted.has("repair-sentinel"), true);
  assert.equal(pending.length, 0);
});

test("all Codex workers declare the exact V2 task class", async () => {
  const mappings = [
    ["season-pack-codex-worker.mjs", "season_pack"],
    ["video-prompt-pack-codex-worker.mjs", "render_pack"],
    ["video-prompt-codex-worker.mjs", "single_generation"],
    ["batch-segment-repair-codex-worker.mjs", "path_repair"],
    ["event-coverage-codex-worker.mjs", "coverage_judge"],
    ["prompt-safety-codex-worker.mjs", "safety_rewrite"],
    ["storyboard-codex-worker.mjs", "visual_asset"],
    ["visual-asset-codex-worker.mjs", "visual_asset"],
  ];

  assert.equal(CODEX_SLOT_TASK_CLASSES.size, 7);
  for (const [fileName, taskClass] of mappings) {
    const source = await readFile(path.join(process.cwd(), "scripts", fileName), "utf8");
    assert.match(source, new RegExp(`withCodexCliSlot\\("${taskClass}"`), fileName);
  }
});

test("V2 coordinator treats the old wait timeout as diagnostic and heartbeats leases", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "codex-cli-slot-coordinator.mjs"), "utf8");
  assert.match(source, /CODEX_FAIR_SCHEDULER_V2/);
  assert.match(source, /wait_threshold_exceeded/);
  assert.match(source, /heartbeat/);
  assert.doesNotMatch(source, /Timed out waiting for a global Codex CLI/);
});

test("stale-fence heartbeat and release are no-ops while a live owner is preserved", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "localdirector-phase2-slot-fence-"));
  process.env.CODEX_CLI_SLOT_ROOT_DIR = rootDir;
  process.env.CODEX_CLI_SLOT_STALE_MS = "60000";
  const coordinator = await import(`../scripts/codex-cli-slot-coordinator.mjs?fence=${Date.now()}`);
  try {
    const release = await coordinator.acquireCodexCliSlot("render_pack", "fence-test");
    const lease = release.lease;
    const wrongFence = { ...lease, fencingToken: "stale-fence" };

    assert.equal(await coordinator.heartbeatCodexCliLease(wrongFence), false);
    assert.equal(await coordinator.releaseCodexCliLease(wrongFence), false);
    assert.equal((await coordinator.inspectCodexCliSlotState()).leases.length, 1);

    const leasePath = path.join(
      rootDir,
      ".tmp-codex-runtime",
      "cli-slots",
      "leases-v2",
      `${lease.waiterId}.json`,
    );
    await writeFile(leasePath, `${JSON.stringify({
      ...lease,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");
    assert.equal((await coordinator.inspectCodexCliSlotState()).leases.length, 1);

    assert.equal(await coordinator.releaseCodexCliLease(lease), true);
    assert.equal(await coordinator.releaseCodexCliLease(lease), false);
  } finally {
    delete process.env.CODEX_CLI_SLOT_ROOT_DIR;
    delete process.env.CODEX_CLI_SLOT_STALE_MS;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("100 physical coordinator callers finish with four slots and no leaked records", { timeout: 45_000 }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "localdirector-phase2r-slot-physical-"));
  Object.assign(process.env, {
    CODEX_CLI_SLOT_ROOT_DIR: rootDir,
    CODEX_CLI_MAX_SLOTS: "4",
    CODEX_CLI_SLOT_POLL_MS: "25",
    CODEX_CLI_SLOT_LOCK_WAIT_MS: "10000",
    CODEX_FAIR_SCHEDULER_V2: "1",
  });
  const coordinator = await import(`../scripts/codex-cli-slot-coordinator.mjs?physical=${Date.now()}`);
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  let renderOutstanding = 75;
  let activeNonOriginal = 0;
  let maxNonOriginalWhileRenderOutstanding = 0;
  const startedAt = Date.now();
  try {
    const calls = Array.from({ length: 100 }, (_, index) => {
      const taskClass = index < 75 ? "render_pack" : "path_repair";
      return coordinator.withCodexCliSlot(taskClass, `physical-${index}`, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (taskClass !== "render_pack") {
          activeNonOriginal += 1;
          if (renderOutstanding > 0) {
            maxNonOriginalWhileRenderOutstanding = Math.max(
              maxNonOriginalWhileRenderOutstanding,
              activeNonOriginal,
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (taskClass === "render_pack") renderOutstanding -= 1;
        else activeNonOriginal -= 1;
        active -= 1;
        completed += 1;
      });
    });
    const outcomes = await Promise.allSettled(calls);
    const elapsedMs = Date.now() - startedAt;
    const state = await coordinator.inspectCodexCliSlotState();
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const lockTimeoutCount = rejected.filter((outcome) => /coordinator state lock/i.test(String(outcome.reason))).length;
    assert.equal(rejected.length, 0, rejected.map((outcome) => String(outcome.reason)).join("\n"));
    assert.equal(lockTimeoutCount, 0);
    assert.equal(completed, 100);
    assert.equal(maxActive, 4);
    assert.ok(maxNonOriginalWhileRenderOutstanding <= 1);
    assert.ok(elapsedMs < 45_000, `physical coordinator took ${elapsedMs}ms`);
    assert.equal(state.waiters.length, 0);
    assert.equal(state.leases.length, 0);
  } finally {
    delete process.env.CODEX_CLI_SLOT_ROOT_DIR;
    delete process.env.CODEX_CLI_MAX_SLOTS;
    delete process.env.CODEX_CLI_SLOT_POLL_MS;
    delete process.env.CODEX_CLI_SLOT_LOCK_WAIT_MS;
    delete process.env.CODEX_FAIR_SCHEDULER_V2;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("Windows ENOTEMPTY coordinator removal is retried without leaking the lock", async () => {
  const coordinator = await import(`../scripts/codex-cli-slot-coordinator.mjs?enotempty=${Date.now()}`);
  let attempts = 0;
  await coordinator.removeCodexCoordinatorPathWithRetry("unused", { recursive: true, force: true }, async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
  });
  assert.equal(attempts, 3);
});
