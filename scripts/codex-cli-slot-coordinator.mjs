import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = process.cwd();
const slotRoot = path.join(rootDir, ".tmp-codex-runtime", "cli-slots");
const maxSlots = clampInteger(process.env.CODEX_CLI_MAX_SLOTS, 8, 1, 16);
const primaryReservedSlots = clampInteger(
  process.env.CODEX_CLI_PRIMARY_RESERVED_SLOTS,
  Math.min(5, maxSlots - 1),
  0,
  Math.max(0, maxSlots - 1),
);
const staleMs = clampInteger(process.env.CODEX_CLI_SLOT_STALE_MS, 75 * 60_000, 60_000, 6 * 60 * 60_000);
const waitTimeoutMs = clampInteger(process.env.CODEX_CLI_SLOT_WAIT_TIMEOUT_MS, 30 * 60_000, 10_000, 2 * 60 * 60_000);

export async function withCodexCliSlot(role, taskId, callback) {
  const release = await acquireCodexCliSlot(role, taskId);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function acquireCodexCliSlot(role, taskId) {
  const normalizedRole = role === "auxiliary" ? "auxiliary" : "primary";
  const startedAt = Date.now();
  await fsp.mkdir(slotRoot, { recursive: true });
  while (Date.now() - startedAt < waitTimeoutMs) {
    const firstSlot = normalizedRole === "auxiliary" ? primaryReservedSlots + 1 : 1;
    for (let slotNumber = firstSlot; slotNumber <= maxSlots; slotNumber += 1) {
      const slotPath = path.join(slotRoot, `slot-${String(slotNumber).padStart(2, "0")}`);
      if (await tryClaimSlot(slotPath, normalizedRole, taskId)) {
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
