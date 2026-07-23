export const CODEX_SLOT_TASK_CLASSES = new Set([
  "season_pack",
  "render_pack",
  "single_generation",
  "path_repair",
  "coverage_judge",
  "safety_rewrite",
  "visual_asset",
]);

const ORIGINAL_VIDEO_TASK_CLASSES = new Set(["season_pack", "render_pack"]);

export function normalizeCodexSlotTaskClass(value) {
  if (CODEX_SLOT_TASK_CLASSES.has(value)) return value;
  if (value === "primary") return "render_pack";
  if (value === "auxiliary") return "path_repair";
  return "path_repair";
}

export function isOriginalVideoTaskClass(value) {
  return ORIGINAL_VIDEO_TASK_CLASSES.has(normalizeCodexSlotTaskClass(value));
}

export function selectCodexSlotGrants({ waiters, leases, maxSlots = 4 }) {
  const capacity = Math.max(1, Math.min(4, Number(maxSlots) || 4));
  const activeLeases = normalizeLeases(leases, capacity);
  const pending = normalizeWaiters(waiters);
  const occupiedSlots = new Set(activeLeases.map((entry) => entry.slotNumber));
  const freeSlots = [];
  for (let slotNumber = 1; slotNumber <= capacity; slotNumber += 1) {
    if (!occupiedSlots.has(slotNumber)) freeSlots.push(slotNumber);
  }

  const grants = [];
  let nonOriginalActive = activeLeases.filter((entry) => !isOriginalVideoTaskClass(entry.taskClass)).length;

  for (const slotNumber of freeSlots) {
    const originalDemand = hasOriginalDemand(pending, activeLeases, grants);
    const eligible = originalDemand && nonOriginalActive >= 1
      ? pending.filter((entry) => isOriginalVideoTaskClass(entry.taskClass))
      : pending;
    const selected = eligible[0];
    if (!selected) break;

    const pendingIndex = pending.findIndex((entry) => entry.waiterId === selected.waiterId);
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
    grants.push({ ...selected, slotNumber });
    if (!isOriginalVideoTaskClass(selected.taskClass)) nonOriginalActive += 1;
  }

  return grants;
}

function hasOriginalDemand(waiters, leases, grants) {
  return waiters.some((entry) => isOriginalVideoTaskClass(entry.taskClass))
    || leases.some((entry) => isOriginalVideoTaskClass(entry.taskClass))
    || grants.some((entry) => isOriginalVideoTaskClass(entry.taskClass));
}

function normalizeWaiters(waiters) {
  return (Array.isArray(waiters) ? waiters : [])
    .filter((entry) => entry && typeof entry.waiterId === "string" && entry.waiterId)
    .map((entry) => ({
      ...entry,
      taskClass: normalizeCodexSlotTaskClass(entry.taskClass),
      requestedAt: normalizeTimestamp(entry.requestedAt),
    }))
    .sort(compareQueueIdentity);
}

function normalizeLeases(leases, maxSlots) {
  const seenSlots = new Set();
  return (Array.isArray(leases) ? leases : [])
    .filter((entry) => entry && Number.isInteger(entry.slotNumber) && entry.slotNumber >= 1 && entry.slotNumber <= maxSlots)
    .filter((entry) => {
      if (seenSlots.has(entry.slotNumber)) return false;
      seenSlots.add(entry.slotNumber);
      return true;
    })
    .map((entry) => ({ ...entry, taskClass: normalizeCodexSlotTaskClass(entry.taskClass) }));
}

function compareQueueIdentity(left, right) {
  return left.requestedAt.localeCompare(right.requestedAt)
    || String(left.waiterId).localeCompare(String(right.waiterId));
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();
}
