import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";
import { withCodexCliSlot } from "./codex-cli-slot-coordinator.mjs";
import { startCodexWorkerRuntimeHealth } from "./codex-runtime-health.mjs";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.BATCH_SEGMENT_REPAIR_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.BATCH_SEGMENT_REPAIR_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.BATCH_SEGMENT_REPAIR_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.BATCH_SEGMENT_REPAIR_CODEX_TASK_TIMEOUT_MS, 20 * 60_000);
const concurrency = Math.max(1, Math.min(3, positiveInteger(process.env.BATCH_SEGMENT_REPAIR_CODEX_CONCURRENCY, 3)));
const workerToken = process.env.BATCH_SEGMENT_REPAIR_CODEX_WORKER_TOKEN || "";
const workerId = process.env.BATCH_SEGMENT_REPAIR_CODEX_WORKER_ID || `batch-segment-repair-${process.pid}`;
const messageDir = path.join(rootDir, ".tmp-batch-segment-repair-codex", "codex-messages");
const workerLock = await acquireWorkerFleetLock("batch-segment-repair-worker", { rootDir });
if (!workerLock.acquired) {
  console.log(`Batch segment repair worker is already running (pid=${workerLock.owner?.pid || "unknown"}).`);
  process.exit(0);
}
const runtimeHealth = await startCodexWorkerRuntimeHealth("batch-segment-repair", { rootDir });
installWorkerShutdown(workerLock);

console.log("Local Director batch segment repairs-only Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Concurrency: ${concurrency}`);

let lastIdleLogAt = 0;
const activeTasks = new Set();

while (true) {
  try {
    runtimeHealth.assertHealthy();
    while (activeTasks.size < concurrency) {
      const task = await claimTask();
      if (!task) break;
      const taskPromise = processTask(task)
        .catch((error) => console.error(error instanceof Error ? error.message : error))
        .finally(() => activeTasks.delete(taskPromise));
      activeTasks.add(taskPromise);
    }
    if (!activeTasks.size) {
      logIdle();
      await delay(pollMs);
    } else if (activeTasks.size >= concurrency) {
      await Promise.race(activeTasks);
    } else {
      await delay(pollMs);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await delay(pollMs);
  }
}

async function processTask(task) {
  console.log(`Claimed repairs-only job ${task.id}.`);
  let outputReady = false;
  try {
    await withCodexCliSlot("auxiliary", task.id, () => runCodex(task));
    await assertRepairPatchJson(task.outputPath, task);
    outputReady = true;
    await postJson(`/api/batch-segment-repair/jobs/${encodeURIComponent(task.id)}/complete`, {
      leaseId: task.leaseId,
      fencingToken: task.fencingToken,
    });
    console.log(`Completed repairs-only job ${task.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.errorCode === "JOB_LEASE_LOST") {
      console.warn(`Discarded stale repair lease for ${task.id}; a newer worker owns the job.`);
      return;
    }
    if (outputReady && isTransientWorkerRequestError(error)) {
      console.warn(`Repair output for ${task.id} is complete; completion will be reconciled from disk: ${message}`);
      return;
    }
    await postJson(`/api/batch-segment-repair/jobs/${encodeURIComponent(task.id)}/fail`, {
      leaseId: task.leaseId,
      fencingToken: task.fencingToken,
      message,
    }).catch((failError) => console.error(`Could not report failed repair job ${task.id}:`, failError));
    throw error;
  }
}

async function claimTask() {
  const data = await postJson("/api/batch-segment-repair/jobs/claim", {});
  return data.task || null;
}

async function postJson(pathname, body) {
  const retryDelaysMs = [0, 25, 75, 200, 500];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt]) await delay(retryDelaysMs[attempt]);
    let response;
    try {
      response = await fetch(`${apiBaseUrl}${pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-id": workerId,
          ...(workerToken ? { "x-batch-segment-repair-codex-token": workerToken } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < retryDelaysMs.length - 1) continue;
      throw new WorkerRequestError(error instanceof Error ? error.message : "Repair API is unavailable", null, 0, true);
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) return data;
    const requestError = new WorkerRequestError(
      data?.error || `Repairs-only worker request failed: ${response.status}`,
      data?.errorCode,
      response.status,
      response.status >= 500,
    );
    if (requestError.errorCode !== "JOB_STORAGE_BUSY" || attempt === retryDelaysMs.length - 1) {
      throw requestError;
    }
  }
  throw new WorkerRequestError("Repairs-only worker request retry budget exhausted", "JOB_STORAGE_BUSY", 503);
}

class WorkerRequestError extends Error {
  constructor(message, errorCode, status, transient = false) {
    super(message);
    this.name = "WorkerRequestError";
    this.errorCode = errorCode || null;
    this.status = status;
    this.transient = transient || errorCode === "JOB_STORAGE_BUSY";
  }
}

function isTransientWorkerRequestError(error) {
  return error instanceof WorkerRequestError && error.transient;
}

async function runCodex(task) {
  const messagePath = path.join(messageDir, `${safeFileName(task.id)}.txt`);
  await fsp.mkdir(path.dirname(messagePath), { recursive: true });
  const command = resolveCodexCommand();
  const args = [
    "exec",
    "--cd",
    rootDir,
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "--output-last-message",
    messagePath,
    "-",
  ];
  await new Promise((resolve, reject) => {
    let capturedOutput = "";
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(buildCodexFailureMessage(`codex exec timed out after ${taskTimeoutMs}ms`, capturedOutput)));
    }, taskTimeoutMs);
    child.stdin.end([
      "You are running a Local Director repairs-only field patch task.",
      "Write only the strict repair patch JSON requested by the task prompt.",
      "Do not emit the full generation payload, storyboard array, workflow object, markdown, or commentary.",
      task.prompt,
    ].join("\n"), "utf8");
    child.stdout?.on("data", (chunk) => {
      capturedOutput = appendCapturedOutput(capturedOutput, chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      capturedOutput = appendCapturedOutput(capturedOutput, chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(buildCodexFailureMessage(error.message, capturedOutput)));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(buildCodexFailureMessage(`codex exec exited with code ${code}`, capturedOutput)));
    });
  });
}

async function assertRepairPatchJson(filePath, task) {
  const raw = stripJsonBom(await fsp.readFile(filePath, "utf8"));
  const result = JSON.parse(raw);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Repair patch JSON is not an object");
  const keys = Object.keys(result);
  if (keys.some((key) => !["schemaVersion", "contractHash", "resultHash", "repairs"].includes(key))) {
    throw new Error("Repair worker returned a complete result instead of repairs-only JSON");
  }
  if (!("schemaVersion" in result) || !("contractHash" in result) || !("resultHash" in result)) {
    throw new Error("Repair patch JSON is missing protocol fields");
  }
  if (!Array.isArray(result.repairs) || !result.repairs.length) throw new Error("Repair patch JSON is missing repairs");
}

function resolveCodexCommand() {
  const explicit = process.env.CODEX_COMMAND?.trim();
  if (explicit) return explicit;
  if (process.platform !== "win32") return "codex";
  for (const candidate of windowsCodexCandidates()) if (fs.existsSync(candidate)) return candidate;
  return "codex";
}

function windowsCodexCandidates() {
  const pathEntries = String(process.env.Path || process.env.PATH || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Roaming") : "");
  const searchDirs = [...new Set([...pathEntries, appData ? path.join(appData, "npm") : ""].filter(Boolean))];
  return searchDirs.flatMap((dir) => ["codex.exe", "codex.cmd", "codex.bat", "codex"].map((name) => path.join(dir, name)));
}

function shouldRunCodexThroughShell(command) {
  return process.platform === "win32" && !/\.exe$/i.test(command);
}

function installWorkerShutdown(lock) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await lock.release().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function stripJsonBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeFileName(value) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logIdle() {
  const now = Date.now();
  if (now - lastIdleLogAt < idleLogMs) return;
  lastIdleLogAt = now;
  console.log("No pending repairs-only jobs.");
}
