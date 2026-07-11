import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = path.resolve(process.env.CODEX_CLI_SLOT_ROOT_DIR || process.cwd());
const slotRoot = path.join(rootDir, ".tmp-codex-runtime", "cli-slots");
const primaryWaiterRoot = path.join(slotRoot, "primary-waiters");
const auxiliaryWaiterRoot = path.join(slotRoot, "auxiliary-waiters");

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
    waitTimeoutMs: clampInteger(env.CODEX_CLI_SLOT_WAIT_TIMEOUT_MS, 30 * 60_000, 10_000, 2 * 60 * 60_000),
  };
}

const { maxSlots, primaryReservedSlots, staleMs, waitTimeoutMs } = resolveCodexCliSlotConfig();

export async function withCodexCliSlot(role, taskId, callback) {
  const release = await acquireCodexCliSlot(role, taskId);
  const execStartedAt = Date.now();
  try {
    return await callback();
  } finally {
    await release();
    await recordSlotMetric({
      event: "exec_completed",
      role: role === "auxiliary" ? "auxiliary" : "primary",
      taskId: String(taskId || "unknown"),
      execDurationMs: Date.now() - execStartedAt,
    });
  }
}

export function resolveCodexCliSlotCandidates(role, config, renderActive, auxiliaryWaiting = false) {
  const maxSlots = Math.max(1, Number(config.maxSlots) || 1);
  const reserved = Math.max(0, Math.min(maxSlots - 1, Number(config.primaryReservedSlots) || 0));
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

export async function acquireCodexCliSlot(role, taskId) {
  const normalizedRole = role === "auxiliary" ? "auxiliary" : "primary";
  const startedAt = Date.now();
  await fsp.mkdir(slotRoot, { recursive: true });
  await fsp.mkdir(primaryWaiterRoot, { recursive: true });
  await fsp.mkdir(auxiliaryWaiterRoot, { recursive: true });
  const waiterRoot = normalizedRole === "primary" ? primaryWaiterRoot : auxiliaryWaiterRoot;
  const waiterPath = path.join(waiterRoot, `${process.pid}-${randomUUID()}.json`);
  await fsp.writeFile(waiterPath, JSON.stringify({ pid: process.pid, taskId, waitingAt: new Date().toISOString() }), "utf8");
  try {
    while (Date.now() - startedAt < waitTimeoutMs) {
      const renderActive = normalizedRole === "primary" || await hasPrimaryDemand();
      const auxiliaryWaiting = normalizedRole === "primary" && await hasWaiterDemand(auxiliaryWaiterRoot);
      const candidates = resolveCodexCliSlotCandidates(
        normalizedRole,
        { maxSlots, primaryReservedSlots },
        renderActive,
        auxiliaryWaiting,
      );
      for (const slotNumber of candidates) {
        const slotPath = path.join(slotRoot, `slot-${String(slotNumber).padStart(2, "0")}`);
        if (await tryClaimSlot(slotPath, normalizedRole, taskId)) {
          if (waiterPath) await fsp.rm(waiterPath, { force: true });
          await recordSlotMetric({
            event: "slot_acquired",
            role: normalizedRole,
            taskId: String(taskId || "unknown"),
            slotNumber,
            queueWaitMs: Date.now() - startedAt,
            activeSlots: await countActiveSlots(),
          });
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            await fsp.rm(slotPath, { recursive: true, force: true });
          };
        }
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for a global Codex CLI ${normalizedRole} slot`);
  } finally {
    if (waiterPath) await fsp.rm(waiterPath, { force: true });
  }
}

async function hasPrimaryDemand() {
  if (await hasWaiterDemand(primaryWaiterRoot)) return true;
  const slotEntries = await fsp.readdir(slotRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of slotEntries.filter((item) => item.isDirectory() && /^slot-\d+$/.test(item.name))) {
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(slotRoot, entry.name, "owner.json"), "utf8"));
      if (owner?.role === "primary") return true;
    } catch {
      // A partially written owner is treated as occupied by the atomic slot directory.
    }
  }
  return false;
}

async function hasWaiterDemand(waiterRoot) {
  const waiterEntries = await fsp.readdir(waiterRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of waiterEntries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const waiterPath = path.join(waiterRoot, entry.name);
    try {
      const info = await fsp.stat(waiterPath);
      if (Date.now() - info.mtimeMs <= waitTimeoutMs + 60_000) return true;
      await fsp.rm(waiterPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function countActiveSlots() {
  const entries = await fsp.readdir(slotRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^slot-\d+$/.test(entry.name)).length;
}

async function recordSlotMetric(metric) {
  try {
    await fsp.mkdir(path.dirname(slotRoot), { recursive: true });
    await fsp.appendFile(
      path.join(path.dirname(slotRoot), "cli-slot-metrics.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...metric })}\n`,
      "utf8",
    );
  } catch {
    // Metrics must never block generation.
  }
}

async function tryClaimSlot(slotPath, role, taskId) {
  try {
    await fsp.mkdir(slotPath);
    await fsp.writeFile(path.join(slotPath, "owner.json"), `${JSON.stringify({
      leaseId: randomUUID(),
      pid: process.pid,
      role,
      taskId: String(taskId || "unknown"),
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const stats = await fsp.stat(slotPath);
      if (Date.now() - stats.mtimeMs > staleMs) await fsp.rm(slotPath, { recursive: true, force: true });
    } catch (statError) {
      if (statError?.code !== "ENOENT") throw statError;
    }
    return false;
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
