import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";
import { withCodexCliSlot } from "./codex-cli-slot-coordinator.mjs";
import { startCodexWorkerRuntimeHealth } from "./codex-runtime-health.mjs";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

process.env.TS_NODE_COMPILER_OPTIONS ||= JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
  finalizeVideoPromptPackCodexJobFiles,
  heartbeatVideoPromptPackCodexJob,
  markVideoPromptPackCodexJobExited,
  updateVideoPromptPackCodexJobStage,
} = require("../lib/video-prompt-pack-codex-queue.ts");

const rootDir = process.cwd();
const apiBaseUrl = (process.env.VIDEO_PROMPT_PACK_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_TASK_TIMEOUT_MS, 30 * 60_000);
const fileJobHeartbeatMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_FILE_JOB_HEARTBEAT_MS, 10_000);
const concurrency = Math.max(1, Math.min(4, positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_CONCURRENCY, 4)));
const workerToken = process.env.VIDEO_PROMPT_PACK_CODEX_WORKER_TOKEN || "";
const workerInstanceId = `${
  process.env.VIDEO_PROMPT_PACK_CODEX_WORKER_ID?.trim() || `video-prompt-pack-${process.pid}`
}-${randomUUID()}`.toLowerCase();
const messageDir = path.join(rootDir, ".tmp-video-prompt-pack-codex", "codex-messages");
const workerLock = await acquireWorkerFleetLock("video-prompt-pack-worker", { rootDir });
if (!workerLock.acquired) {
  console.log(`Video prompt Render Pack worker is already running (pid=${workerLock.owner?.pid || "unknown"}).`);
  process.exit(0);
}
const runtimeHealth = await startCodexWorkerRuntimeHealth("video-prompt-pack", { rootDir, workerInstanceId });
installWorkerShutdown(workerLock);

console.log("Local Director video prompt Render Pack Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollMs}ms`);
console.log(`Task timeout: ${taskTimeoutMs}ms`);
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
        .catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        })
        .finally(() => {
          activeTasks.delete(taskPromise);
        });
      activeTasks.add(taskPromise);
    }

    if (!activeTasks.size) {
      logIdle();
      await delay(pollMs);
      continue;
    }
    if (activeTasks.size >= concurrency) {
      await Promise.race(activeTasks);
      continue;
    }
    await delay(pollMs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await delay(pollMs);
  }
}

async function processTask(task) {
  console.log(`Claimed video prompt Render Pack job ${task.id} (${task.segments?.length || 0} segments).`);
  let outputReady = false;
  let stopFileJobHeartbeat = () => undefined;
  try {
    let activeTask = await updateVideoPromptPackCodexJobStage(
      task.id,
      task.leaseId,
      task.fencingToken,
      "waiting_slot",
      { rootDir },
    );
    stopFileJobHeartbeat = startFileJobHeartbeat(() => heartbeatVideoPromptPackCodexJob(
      task.id,
      task.leaseId,
      task.fencingToken,
      { rootDir },
    ));
    await withCodexCliSlot("render_pack", task.id, async () => {
      activeTask = await updateVideoPromptPackCodexJobStage(
        task.id,
        task.leaseId,
        task.fencingToken,
        "executing",
        { rootDir },
      );
      await runCodex(activeTask);
      activeTask = await markVideoPromptPackCodexJobExited(
        task.id,
        task.leaseId,
        task.fencingToken,
        { rootDir },
      );
    });
    activeTask = await updateVideoPromptPackCodexJobStage(
      task.id,
      task.leaseId,
      task.fencingToken,
      "finalizing",
      { rootDir },
    );
    const finalized = await finalizeVideoPromptPackCodexJobFiles(activeTask, {
      rootDir,
      codexExitCode: 0,
    });
    outputReady = true;
    await completeTask(activeTask, finalized.resultRef);
    console.log(`Completed video prompt Render Pack job ${task.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = typeof error?.code === "string" ? error.code : error?.errorCode;
    if (errorCode === "JOB_LEASE_LOST" || errorCode === "FINALIZATION_STALE_FENCE") {
      console.warn(`Discarded stale Render Pack lease for ${task.id}; a newer worker owns the job.`);
      return;
    }
    if (outputReady) {
      console.warn(`Render Pack output for ${task.id} is complete; completion will be reconciled from disk: ${message}`);
      return;
    }
    await failTask(task, message, errorCode).catch((failError) => {
      console.error(`Could not report failed video prompt Render Pack job ${task.id}:`, failError);
    });
    console.error(`Video prompt Render Pack job ${task.id} failed: ${message}`);
  } finally {
    stopFileJobHeartbeat();
  }
}

function startFileJobHeartbeat(heartbeat) {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await heartbeat();
    } catch {
      // Lease loss is handled by the main task transition.
    } finally {
      inFlight = false;
    }
  }, fileJobHeartbeatMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function claimTask() {
  const data = await postJson("/api/video-prompt-packs/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task, resultRef) {
  await postJson(`/api/video-prompt-packs/jobs/${encodeURIComponent(task.id)}/complete`, {
    leaseId: task.leaseId,
    fencingToken: task.fencingToken,
    resultRef,
  });
}

async function failTask(task, message, errorCode) {
  await postJson(`/api/video-prompt-packs/jobs/${encodeURIComponent(task.id)}/fail`, {
    leaseId: task.leaseId,
    fencingToken: task.fencingToken,
    message,
    errorCode,
  });
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
          "x-worker-id": workerInstanceId,
          ...(workerToken ? { "x-video-prompt-pack-codex-token": workerToken } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < retryDelaysMs.length - 1) continue;
      throw new WorkerRequestError(error instanceof Error ? error.message : "Render Pack API is unavailable", null, 0, true);
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) return data;
    const requestError = new WorkerRequestError(
      data?.error || `Video prompt Render Pack Codex worker request failed: ${response.status}`,
      data?.errorCode,
      response.status,
      response.status >= 500,
    );
    if (!requestError.transient || attempt === retryDelaysMs.length - 1) {
      throw requestError;
    }
  }
  throw new WorkerRequestError("Video prompt Render Pack request retry budget exhausted", "JOB_STORAGE_BUSY", 503);
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

function buildCodexPrompt(task) {
  return [
    "You are running Local Director video prompt Render Pack generation from a local Codex CLI worker.",
    "The task prompt already contains every segment render script and exact output paths.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "Write each segment as its own complete Local Director video prompt result JSON file.",
    "Do not use 同上, 如上, 略, or any placeholder that points to another segment.",
    "",
    "Render Pack task prompt:",
    task.prompt,
    "",
    "After writing and validating all JSON files, reply with exactly one line: DONE.",
  ].join("\n");
}

async function runCodex(task) {
  const messagePath = codexMessagePath(task);
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

  console.log(`Running codex exec for video prompt Render Pack job ${task.id}.`);
  await new Promise((resolve, reject) => {
    let capturedOutput = "";
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(buildCodexFailureMessage(`codex exec timed out after ${taskTimeoutMs}ms`, capturedOutput)));
    }, taskTimeoutMs);

    child.stdin.end(buildCodexPrompt(task), "utf8");
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
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(buildCodexFailureMessage(`codex exec exited with code ${code}`, capturedOutput)));
    });
  });
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

function logIdle() {
  const now = Date.now();
  if (now - lastIdleLogAt >= idleLogMs) {
    lastIdleLogAt = now;
    console.log("No pending video prompt Render Pack Codex jobs.");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeFileName(value) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}

function resolveCodexCommand() {
  if (process.env.CODEX_CLI_PATH?.trim()) return process.env.CODEX_CLI_PATH.trim();
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function shouldRunCodexThroughShell(command) {
  return process.platform === "win32" || /[\\/\s]/.test(command);
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
