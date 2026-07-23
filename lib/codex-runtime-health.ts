import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type CodexRuntimeEnvironmentHealth = {
  schemaVersion: 1;
  status: "healthy" | "invalid";
  checkedAt: string;
  codexVersion: string;
  runtimeFingerprint: string;
  errors: Array<{ code: string; path: string; message: string }>;
};

export type CodexWorkerHeartbeat = {
  schemaVersion: 1;
  workerName: string;
  workerInstanceId?: string;
  pid: number;
  heartbeatAt: string;
  runtimeFingerprint: string;
  status: "healthy" | "invalid";
  environment?: CodexRuntimeEnvironmentHealth;
};

export type CodexOwnerHealthDecision = {
  status: "healthy" | "stale" | "missing" | "invalid" | "unverifiable";
  matchKind: "worker_instance" | "legacy_pid" | "none";
  environment: CodexRuntimeEnvironmentHealth | null;
  worker: CodexWorkerHeartbeat | null;
  heartbeatAgeMs?: number;
};

export async function readCodexRuntimeHealth(
  workerName: string,
  options: { rootDir?: string; maxAgeMs?: number; now?: number; workerInstanceId?: string } = {},
) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const now = options.now ?? Date.now();
  const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
  const normalizedWorkerName = normalizeWorkerName(workerName);
  const worker = await readLatestWorkerHeartbeat(runtimeRoot, normalizedWorkerName, options.workerInstanceId);
  return evaluateWorkerHeartbeat(runtimeRoot, worker, { now, maxAgeMs });
}

export async function readCodexRuntimeHealthForOwner(
  workerName: string,
  ownerId: string,
  options: { rootDir?: string; maxAgeMs?: number; now?: number } = {},
): Promise<CodexOwnerHealthDecision> {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const now = options.now ?? Date.now();
  const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
  const normalizedWorkerName = normalizeWorkerName(workerName);
  const normalizedOwnerId = String(ownerId || "").trim().toLowerCase();

  if (!normalizedOwnerId) {
    const environment = await readJson<CodexRuntimeEnvironmentHealth>(path.join(runtimeRoot, "environment.json"));
    return {
      status: "unverifiable",
      matchKind: "none",
      environment,
      worker: null,
    };
  }

  const exactWorker = await readLatestWorkerHeartbeat(runtimeRoot, normalizedWorkerName, normalizedOwnerId);
  if (exactWorker) {
    return {
      ...await evaluateWorkerHeartbeat(runtimeRoot, exactWorker, { now, maxAgeMs }),
      matchKind: "worker_instance",
    };
  }

  const legacyPid = parseLegacyOwnerPid(normalizedWorkerName, normalizedOwnerId);
  if (legacyPid !== null) {
    const legacyWorker = await readLatestLegacyWorkerHeartbeat(runtimeRoot, normalizedWorkerName, legacyPid);
    return {
      ...await evaluateWorkerHeartbeat(runtimeRoot, legacyWorker, { now, maxAgeMs }),
      matchKind: legacyWorker ? "legacy_pid" : "none",
    };
  }

  const legacyWorker = await readLatestLegacyWorkerHeartbeat(runtimeRoot, normalizedWorkerName);
  const legacyHealth = await evaluateWorkerHeartbeat(runtimeRoot, legacyWorker, { now, maxAgeMs });
  if (legacyHealth.status === "healthy" || legacyHealth.status === "invalid") {
    return {
      ...legacyHealth,
      status: "unverifiable",
      matchKind: "none",
    };
  }
  return {
    ...legacyHealth,
    matchKind: "none",
  };
}

async function readLatestWorkerHeartbeat(runtimeRoot: string, workerName: string, workerInstanceId?: string) {
  const candidates = await readWorkerHeartbeats(runtimeRoot, workerName);
  return candidates
    .filter((worker) => !workerInstanceId || worker.workerInstanceId === workerInstanceId)
    .sort(compareHeartbeatFreshness)[0] || null;
}

async function readLatestLegacyWorkerHeartbeat(runtimeRoot: string, workerName: string, pid?: number) {
  const candidates = await readWorkerHeartbeats(runtimeRoot, workerName);
  return candidates
    .filter((worker) => !worker.workerInstanceId && (pid === undefined || worker.pid === pid))
    .sort(compareHeartbeatFreshness)[0] || null;
}

async function readWorkerHeartbeats(runtimeRoot: string, workerName: string) {
  const workerRoot = path.join(runtimeRoot, "workers");
  const candidates: CodexWorkerHeartbeat[] = [];
  try {
    const fileNames = await readdir(workerRoot);
    for (const fileName of fileNames) {
      if (fileName !== `${workerName}.json` && !fileName.startsWith(`${workerName}.`)) continue;
      if (!fileName.endsWith(".json")) continue;
      const worker = await readJson<CodexWorkerHeartbeat>(path.join(workerRoot, fileName));
      if (worker?.workerName === workerName) candidates.push(worker);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidates;
}

async function evaluateWorkerHeartbeat(
  runtimeRoot: string,
  worker: CodexWorkerHeartbeat | null,
  options: { now: number; maxAgeMs: number },
) {
  const environment = worker?.environment
    || await readJson<CodexRuntimeEnvironmentHealth>(path.join(runtimeRoot, "environment.json"));
  if (!environment) return { status: "missing" as const, environment: null, worker };
  if (environment.status !== "healthy") return { status: "invalid" as const, environment, worker };
  if (!worker) return { status: "missing" as const, environment, worker: null };
  const heartbeatAgeMs = options.now - Date.parse(worker.heartbeatAt);
  if (
    !Number.isFinite(heartbeatAgeMs)
    || heartbeatAgeMs < -5_000
    || heartbeatAgeMs > options.maxAgeMs
    || worker.runtimeFingerprint !== environment.runtimeFingerprint
    || worker.status !== "healthy"
  ) {
    return { status: "stale" as const, environment, worker, heartbeatAgeMs };
  }
  return { status: "healthy" as const, environment, worker, heartbeatAgeMs };
}

function compareHeartbeatFreshness(left: CodexWorkerHeartbeat, right: CodexWorkerHeartbeat) {
  return Date.parse(right.heartbeatAt || "") - Date.parse(left.heartbeatAt || "");
}

function parseLegacyOwnerPid(workerName: string, ownerId: string) {
  const match = ownerId.match(new RegExp(`^${escapeRegExp(workerName)}-(\\d+)$`));
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeWorkerName(value: string) {
  const workerName = String(value || "").trim().toLowerCase();
  if (!workerName || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(workerName)) throw new Error("Invalid Codex worker name");
  return workerName;
}
