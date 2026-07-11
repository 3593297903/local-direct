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
  pid: number;
  heartbeatAt: string;
  runtimeFingerprint: string;
  status: "healthy" | "invalid";
  environment?: CodexRuntimeEnvironmentHealth;
};

export async function readCodexRuntimeHealth(
  workerName: string,
  options: { rootDir?: string; maxAgeMs?: number; now?: number } = {},
) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const now = options.now ?? Date.now();
  const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
  const normalizedWorkerName = normalizeWorkerName(workerName);
  const worker = await readLatestWorkerHeartbeat(runtimeRoot, normalizedWorkerName);
  const environment = worker?.environment
    || await readJson<CodexRuntimeEnvironmentHealth>(path.join(runtimeRoot, "environment.json"));
  if (!environment) return { status: "missing" as const, environment: null, worker };
  if (environment.status !== "healthy") return { status: "invalid" as const, environment, worker };
  if (!worker) return { status: "missing" as const, environment, worker: null };
  const heartbeatAgeMs = now - Date.parse(worker.heartbeatAt);
  if (
    !Number.isFinite(heartbeatAgeMs)
    || heartbeatAgeMs < -5_000
    || heartbeatAgeMs > maxAgeMs
    || worker.runtimeFingerprint !== environment.runtimeFingerprint
    || worker.status !== "healthy"
  ) {
    return { status: "stale" as const, environment, worker, heartbeatAgeMs };
  }
  return { status: "healthy" as const, environment, worker, heartbeatAgeMs };
}

async function readLatestWorkerHeartbeat(runtimeRoot: string, workerName: string) {
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
  return candidates.sort((left, right) => (
    Date.parse(right.heartbeatAt || "") - Date.parse(left.heartbeatAt || "")
  ))[0] || null;
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
