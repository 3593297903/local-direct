import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";
import { withCodexCliSlot } from "./codex-cli-slot-coordinator.mjs";
import { startCodexWorkerRuntimeHealth } from "./codex-runtime-health.mjs";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.EVENT_COVERAGE_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.EVENT_COVERAGE_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.EVENT_COVERAGE_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.EVENT_COVERAGE_CODEX_TASK_TIMEOUT_MS, 12 * 60_000);
const concurrency = Math.max(1, Math.min(2, positiveInteger(process.env.EVENT_COVERAGE_CODEX_CONCURRENCY, 1)));
const workerToken = process.env.EVENT_COVERAGE_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-event-coverage-codex", "codex-messages");
const workerLock = await acquireWorkerFleetLock("event-coverage-worker", { rootDir });
if (!workerLock.acquired) {
  console.log(`Event coverage worker is already running (pid=${workerLock.owner?.pid || "unknown"}).`);
  process.exit(0);
}
const runtimeHealth = await startCodexWorkerRuntimeHealth("event-coverage", { rootDir });
installWorkerShutdown(workerLock);

console.log("Local Director event coverage decisions-only Codex worker started.");
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
  console.log(`Claimed event coverage wave ${task.waveId}.`);
  try {
    await withCodexCliSlot("auxiliary", task.id, () => runCodex(task));
    await assertDecisionsOnlyJson(task.outputPath, task);
    await postJson(`/api/event-coverage/jobs/${encodeURIComponent(task.id)}/complete`, { leaseId: task.leaseId });
    console.log(`Completed event coverage wave ${task.waveId}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await postJson(`/api/event-coverage/jobs/${encodeURIComponent(task.id)}/fail`, { leaseId: task.leaseId, message })
      .catch((failError) => console.error(`Could not report failed judge wave ${task.waveId}:`, failError));
    throw error;
  }
}

async function claimTask() {
  const data = await postJson("/api/event-coverage/jobs/claim", {});
  return data.task || null;
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-event-coverage-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || `Event coverage worker request failed: ${response.status}`);
  return data;
}

async function runCodex(task) {
  const messagePath = path.join(messageDir, `${safeFileName(task.id)}.txt`);
  await fsp.mkdir(path.dirname(messagePath), { recursive: true });
  const command = resolveCodexCommand();
  const args = ["exec", "--cd", rootDir, "--skip-git-repo-check", "--sandbox", "danger-full-access", "--output-last-message", messagePath, "-"];
  await new Promise((resolve, reject) => {
    let capturedOutput = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(buildCodexFailureMessage(`codex exec timed out after ${taskTimeoutMs}ms`, capturedOutput)));
    }, taskTimeoutMs);
    child.stdin.end([
      "Return only the decisions-only JSON requested by this Local Director judge wave.",
      "Do not generate prompts, repairs, replacements, workflow, storyboard, markdown, or commentary.",
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

async function assertDecisionsOnlyJson(filePath, task) {
  const raw = stripJsonBom(await fsp.readFile(filePath, "utf8"));
  const result = JSON.parse(raw);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Judge output is not an object");
  if (Object.keys(result).some((key) => !["schemaVersion", "waveId", "decisions"].includes(key))) {
    throw new Error("Judge worker returned data outside the decisions-only protocol");
  }
  if (result.schemaVersion !== 1 || result.waveId !== task.waveId || !Array.isArray(result.decisions)) {
    throw new Error("Judge output schema or waveId mismatch");
  }
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
  const dirs = [...new Set([...pathEntries, appData ? path.join(appData, "npm") : ""].filter(Boolean))];
  return dirs.flatMap((dir) => ["codex.exe", "codex.cmd", "codex.bat", "codex"].map((name) => path.join(dir, name)));
}

function shouldRunCodexThroughShell(command) {
  return process.platform === "win32" && !/\.exe$/i.test(command);
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
  console.log("No pending event coverage waves.");
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
