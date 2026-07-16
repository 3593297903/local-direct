import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  normalizeCodexSlotTaskClass,
  selectCodexSlotGrants,
} from "./codex-cli-slot-policy.mjs";

const rootDir = path.resolve(process.env.CODEX_CLI_SLOT_ROOT_DIR || process.cwd());
const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
const slotRoot = path.join(runtimeRoot, "cli-slots");
const waiterRoot = path.join(slotRoot, "waiters-v2");
const leaseRoot = path.join(slotRoot, "leases-v2");
const coordinatorLockPath = path.join(slotRoot, "coordinator-v2.lock");
const legacyPrimaryWaiterRoot = path.join(slotRoot, "primary-waiters");
const legacyAuxiliaryWaiterRoot = path.join(slotRoot, "auxiliary-waiters");

export function resolveCodexCliSlotConfig(env = process.env) {
  const maxSlots = clampInteger(env.CODEX_CLI_MAX_SLOTS, 4, 1, 4);
  return {
    maxSlots,
    primaryReservedSlots: clampInteger(
      env.CODEX_CLI_PRIMARY_RESERVED_SLOTS,
      Math.min(3, maxSlots - 1),
      0,
      Math.max(0, maxSlots - 1),
    ),
    staleMs: clampInteger(env.CODEX_CLI_SLOT_STALE_MS, 75 * 60_000, 60_000, 6 * 60 * 60_000),
    waitAlertMs: clampInteger(env.CODEX_CLI_SLOT_WAIT_TIMEOUT_MS, 30 * 60_000, 10_000, 2 * 60 * 60_000),
    pollMs: clampInteger(env.CODEX_CLI_SLOT_POLL_MS, 100, 25, 2_000),
    lockWaitMs: clampInteger(env.CODEX_CLI_SLOT_LOCK_WAIT_MS, 10_000, 1_000, 60_000),
    lockStaleMs: clampInteger(env.CODEX_CLI_SLOT_LOCK_STALE_MS, 30_000, 5_000, 5 * 60_000),
  };
}

const config = resolveCodexCliSlotConfig();
let lastGrantStaleRecoveryAt = 0;
let capacityFullUntil = 0;
let grantTurnTail = Promise.resolve();

export async function withCodexCliSlot(taskClass, taskId, callback) {
  const release = await acquireCodexCliSlot(taskClass, taskId);
  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, Math.floor(config.staleMs / 3)));
  const heartbeatTimer = release.heartbeat
    ? setInterval(() => void release.heartbeat().catch(() => undefined), heartbeatIntervalMs)
    : undefined;
  heartbeatTimer?.unref?.();
  const execStartedAt = Date.now();
  try {
    return await callback(release.lease);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await release();
    void recordSlotMetric({
      event: "exec_completed",
      taskClass: normalizeCodexSlotTaskClass(taskClass),
      taskId: String(taskId || "unknown"),
      execDurationMs: Date.now() - execStartedAt,
    });
  }
}

export async function acquireCodexCliSlot(taskClass, taskId) {
  if (String(process.env.CODEX_FAIR_SCHEDULER_V2 || "1") === "0") {
    return acquireLegacyCodexCliSlot(taskClass, taskId);
  }
  return acquireFairCodexCliSlot(taskClass, taskId);
}

export async function inspectCodexCliSlotState() {
  await ensureV2Directories();
  return withCoordinatorLock(async () => {
    await recoverStaleRecords();
    return {
      waiters: await readJsonRecords(waiterRoot),
      leases: await readJsonRecords(leaseRoot),
    };
  });
}

export async function heartbeatCodexCliLease(leaseIdentity) {
  if (!leaseIdentity?.waiterId || !leaseIdentity?.leaseId || !leaseIdentity?.fencingToken) return false;
  await ensureV2Directories();
  return withCoordinatorLock(async () => {
    const leasePath = v2RecordPath(leaseRoot, leaseIdentity.waiterId);
    const current = await readJsonFile(leasePath);
    if (!sameLease(current, leaseIdentity)) return false;
    await fsp.writeFile(leasePath, `${JSON.stringify({
      ...current,
      heartbeatAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    return true;
  });
}

export async function releaseCodexCliLease(leaseIdentity) {
  if (!leaseIdentity?.waiterId || !leaseIdentity?.leaseId || !leaseIdentity?.fencingToken) return false;
  await ensureV2Directories();
  return withCoordinatorLock(async () => {
    const leasePath = v2RecordPath(leaseRoot, leaseIdentity.waiterId);
    const current = await readJsonFile(leasePath);
    if (!sameLease(current, leaseIdentity)) return false;
    await fsp.rm(leasePath, { force: true });
    capacityFullUntil = 0;
    return true;
  });
}

export function resolveCodexCliSlotCandidates(role, currentConfig, renderActive, auxiliaryWaiting = false) {
  const maxSlots = Math.max(1, Number(currentConfig.maxSlots) || 1);
  const reserved = Math.max(0, Math.min(maxSlots - 1, Number(currentConfig.primaryReservedSlots) || 0));
  if (role !== "auxiliary") {
    const usable = auxiliaryWaiting && maxSlots > 1 ? maxSlots - 1 : maxSlots;
    return Array.from({ length: usable }, (_, index) => index + 1);
  }
  if (renderActive) return Array.from({ length: maxSlots - reserved }, (_, index) => reserved + index + 1);
  const candidates = [];
  for (let slot = maxSlots; slot >= 2 && candidates.length < Math.min(3, maxSlots - 1); slot -= 1) {
    candidates.push(slot);
  }
  return candidates.length ? candidates : [maxSlots];
}

async function acquireFairCodexCliSlot(taskClass, taskId) {
  const normalizedTaskClass = normalizeCodexSlotTaskClass(taskClass);
  const waiterId = `${process.pid}-${randomUUID()}`;
  const requestedAt = new Date().toISOString();
  const waiter = {
    protocolVersion: 2,
    waiterId,
    pid: process.pid,
    taskClass: normalizedTaskClass,
    taskId: String(taskId || "unknown"),
    requestedAt,
  };
  const startedAt = Date.now();
  let alertRecorded = false;
  let pollAttempt = 0;
  await ensureV2Directories();
  await fsp.writeFile(v2RecordPath(waiterRoot, waiterId), `${JSON.stringify(waiter, null, 2)}\n`, "utf8");

  try {
    for (;;) {
      const grantState = await grantOrReadLease(waiterId, pollAttempt);
      const lease = grantState.lease;
      if (lease) {
        void recordSlotMetric({
          event: "slot_acquired",
          taskClass: normalizedTaskClass,
          taskId: waiter.taskId,
          slotNumber: lease.slotNumber,
          queueWaitMs: Date.now() - startedAt,
          activeSlots: grantState.activeSlots,
        });
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          await releaseCodexCliLease(lease);
        };
        release.lease = lease;
        release.heartbeat = () => heartbeatCodexCliLease(lease);
        return release;
      }
      if (!alertRecorded && Date.now() - startedAt >= config.waitAlertMs) {
        alertRecorded = true;
        void recordSlotMetric({
          event: "wait_threshold_exceeded",
          taskClass: normalizedTaskClass,
          taskId: waiter.taskId,
          queueWaitMs: Date.now() - startedAt,
        });
      }
      await delay(coordinatorPollDelay(config.pollMs, pollAttempt));
      pollAttempt += 1;
    }
  } catch (error) {
    await fsp.rm(v2RecordPath(waiterRoot, waiterId), { force: true }).catch(() => undefined);
    throw error;
  }
}

async function grantOrReadLease(waiterId, pollAttempt = 0) {
  const leasePath = v2RecordPath(leaseRoot, waiterId);
  const ownLease = await readJsonFile(leasePath);
  if (ownLease) {
    return {
      lease: ownLease,
      activeSlots: Number(ownLease.activeSlotsAtGrant || 1),
    };
  }
  const forceStaleSweep = pollAttempt > 0 && pollAttempt % 20 === 0;
  if (Date.now() < capacityFullUntil && !forceStaleSweep) {
    return { lease: undefined, activeSlots: config.maxSlots };
  }
  return withGrantTurn(async () => {
    const currentOwnLease = await readJsonFile(leasePath);
    if (currentOwnLease) {
      return {
        lease: currentOwnLease,
        activeSlots: Number(currentOwnLease.activeSlotsAtGrant || 1),
      };
    }
    if (Date.now() < capacityFullUntil && !forceStaleSweep) {
      return { lease: undefined, activeSlots: config.maxSlots };
    }
    const visibleLeases = await readJsonRecords(leaseRoot);
    if (visibleLeases.length >= config.maxSlots && !forceStaleSweep) {
      capacityFullUntil = Date.now() + 250;
      return { lease: undefined, activeSlots: visibleLeases.length };
    }
    return withCoordinatorLock(async () => {
      if (forceStaleSweep || Date.now() - lastGrantStaleRecoveryAt >= 5_000) {
        await recoverStaleRecords();
        lastGrantStaleRecoveryAt = Date.now();
      }
      const existing = await readJsonFile(leasePath);
      if (existing) {
        return {
          lease: existing,
          activeSlots: Number(existing.activeSlotsAtGrant || 1),
        };
      }

      const waiters = await readJsonRecords(waiterRoot);
      const leases = await readJsonRecords(leaseRoot);
      const grants = selectCodexSlotGrants({ waiters, leases, maxSlots: config.maxSlots });
      const now = new Date().toISOString();
      const activeSlotsAtGrant = Math.min(config.maxSlots, leases.length + grants.length);
      capacityFullUntil = activeSlotsAtGrant >= config.maxSlots ? Date.now() + 250 : 0;
      let grantedOwnLease;
      for (const grant of grants) {
        const lease = {
          protocolVersion: 2,
          waiterId: grant.waiterId,
          leaseId: randomUUID(),
          fencingToken: randomUUID(),
          pid: grant.pid,
          taskClass: grant.taskClass,
          taskId: String(grant.taskId || "unknown"),
          slotNumber: grant.slotNumber,
          requestedAt: grant.requestedAt,
          acquiredAt: now,
          heartbeatAt: now,
          activeSlotsAtGrant,
        };
        await fsp.writeFile(v2RecordPath(leaseRoot, grant.waiterId), `${JSON.stringify(lease, null, 2)}\n`, "utf8");
        await fsp.rm(v2RecordPath(waiterRoot, grant.waiterId), { force: true });
        if (grant.waiterId === waiterId) grantedOwnLease = lease;
      }
      return {
        lease: grantedOwnLease,
        activeSlots: grantedOwnLease ? activeSlotsAtGrant : leases.length,
      };
    });
  });
}

async function withGrantTurn(callback) {
  const previous = grantTurnTail;
  let releaseTurn;
  grantTurnTail = new Promise((resolve) => { releaseTurn = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    releaseTurn();
  }
}

async function recoverStaleRecords() {
  const now = Date.now();
  const leases = await readJsonRecords(leaseRoot);
  for (const lease of leases) {
    const heartbeatAt = Date.parse(String(lease.heartbeatAt || lease.acquiredAt || ""));
    if (Number.isFinite(heartbeatAt) && now - heartbeatAt > config.staleMs && !isProcessAlive(lease.pid)) {
      await fsp.rm(v2RecordPath(leaseRoot, lease.waiterId), { force: true });
    }
  }
  const waiters = await readJsonRecords(waiterRoot);
  for (const waiter of waiters) {
    const requestedAt = Date.parse(String(waiter.requestedAt || ""));
    if (Number.isFinite(requestedAt) && now - requestedAt > config.staleMs && !isProcessAlive(waiter.pid)) {
      await fsp.rm(v2RecordPath(waiterRoot, waiter.waiterId), { force: true });
    }
  }
}

async function ensureV2Directories() {
  await fsp.mkdir(waiterRoot, { recursive: true });
  await fsp.mkdir(leaseRoot, { recursive: true });
}

async function withCoordinatorLock(callback) {
  const release = await acquireCoordinatorLock();
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function acquireCoordinatorLock() {
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      await fsp.mkdir(coordinatorLockPath);
      await fsp.writeFile(path.join(coordinatorLockPath, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await removeCodexCoordinatorPathWithRetry(coordinatorLockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST" && !isWindowsTransientError(error)) throw error;
      const owner = await readJsonFile(path.join(coordinatorLockPath, "owner.json"));
      const stats = await fsp.stat(coordinatorLockPath).catch(() => undefined);
      const stale = stats && Date.now() - stats.mtimeMs > config.lockStaleMs;
      if (stale && !isProcessAlive(owner?.pid)) {
        await removeCodexCoordinatorPathWithRetry(coordinatorLockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= config.lockWaitMs) {
        throw new Error("Timed out acquiring the Codex CLI coordinator state lock");
      }
      await delay(coordinatorLockRetryDelay(attempt));
      attempt += 1;
    }
  }
}

async function readJsonRecords(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const record = await readJsonFile(path.join(directory, entry.name));
    if (record) records.push(record);
  }
  return records;
}

async function readJsonFile(filePath, attempt = 0) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    if (isWindowsTransientError(error) && attempt < 8) {
      await delay(10 * (attempt + 1));
      return readJsonFile(filePath, attempt + 1);
    }
    if (isWindowsTransientError(error)) return undefined;
    throw error;
  }
}

export async function removeCodexCoordinatorPathWithRetry(
  target,
  options,
  remove = (targetPath, removeOptions) => fsp.rm(targetPath, removeOptions),
  attempt = 0,
) {
  try {
    await remove(target, options);
  } catch (error) {
    if (!isWindowsTransientError(error) || attempt >= 8) throw error;
    await delay(10 * (attempt + 1));
    await removeCodexCoordinatorPathWithRetry(target, options, remove, attempt + 1);
  }
}

function isWindowsTransientError(error) {
  return ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(error?.code);
}

function coordinatorPollDelay(baseMs, attempt) {
  const boundedBase = Math.min(750, Math.max(25, baseMs) * (1.6 ** Math.min(attempt, 8)));
  return Math.max(25, Math.round(boundedBase * (0.85 + Math.random() * 0.3)));
}

function coordinatorLockRetryDelay(attempt) {
  const boundedBase = Math.min(40, 5 + attempt * 2);
  return Math.max(5, Math.round(boundedBase * (0.8 + Math.random() * 0.4)));
}

function v2RecordPath(directory, recordId) {
  return path.join(directory, `${String(recordId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function sameLease(current, expected) {
  return current?.leaseId === expected.leaseId
    && current?.fencingToken === expected.fencingToken
    && current?.waiterId === expected.waiterId;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireLegacyCodexCliSlot(taskClass, taskId) {
  const role = ["season_pack", "render_pack", "single_generation"].includes(taskClass) || taskClass === "primary"
    ? "primary"
    : "auxiliary";
  await fsp.mkdir(slotRoot, { recursive: true });
  await fsp.mkdir(legacyPrimaryWaiterRoot, { recursive: true });
  await fsp.mkdir(legacyAuxiliaryWaiterRoot, { recursive: true });
  const waiterDirectory = role === "primary" ? legacyPrimaryWaiterRoot : legacyAuxiliaryWaiterRoot;
  const waiterPath = path.join(waiterDirectory, `${process.pid}-${randomUUID()}.json`);
  await fsp.writeFile(waiterPath, JSON.stringify({ pid: process.pid, taskId, waitingAt: new Date().toISOString() }), "utf8");
  try {
    for (;;) {
      const candidates = resolveCodexCliSlotCandidates(role, config, role === "primary" || await hasLegacyWaiters(legacyPrimaryWaiterRoot));
      for (const slotNumber of candidates) {
        const slotPath = path.join(slotRoot, `legacy-slot-${String(slotNumber).padStart(2, "0")}`);
        try {
          await fsp.mkdir(slotPath);
          await fsp.rm(waiterPath, { force: true });
          let released = false;
          return Object.assign(async () => {
            if (released) return;
            released = true;
            await fsp.rm(slotPath, { recursive: true, force: true });
          }, { lease: { slotNumber, taskClass: normalizeCodexSlotTaskClass(taskClass) } });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      await delay(config.pollMs);
    }
  } finally {
    await fsp.rm(waiterPath, { force: true });
  }
}

async function hasLegacyWaiters(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
}

async function recordSlotMetric(metric) {
  try {
    await fsp.mkdir(runtimeRoot, { recursive: true });
    await fsp.appendFile(
      path.join(runtimeRoot, "cli-slot-metrics.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...metric })}\n`,
      "utf8",
    );
  } catch {
    // Metrics must never block generation.
  }
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
