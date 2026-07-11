import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";
import { withCodexCliSlot } from "./codex-cli-slot-coordinator.mjs";
import { startCodexWorkerRuntimeHealth } from "./codex-runtime-health.mjs";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.VISUAL_ASSET_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.VISUAL_ASSET_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.VISUAL_ASSET_CODEX_IDLE_LOG_MS, 30_000);
const concurrency = positiveInteger(process.env.VISUAL_ASSET_CODEX_CONCURRENCY, 2);
const taskTimeoutMs = positiveInteger(process.env.VISUAL_ASSET_CODEX_TASK_TIMEOUT_MS, 30 * 60_000);
const workerToken = process.env.VISUAL_ASSET_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-visual-asset-codex", "codex-messages");
const logDir = path.join(rootDir, ".tmp-visual-asset-codex", "codex-logs");
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const workerLock = await acquireWorkerFleetLock("visual-asset-worker", { rootDir });
if (!workerLock.acquired) {
  console.log(`Visual asset worker is already running (pid=${workerLock.owner?.pid || "unknown"}).`);
  process.exit(0);
}
const runtimeHealth = await startCodexWorkerRuntimeHealth("visual-asset", { rootDir });
installWorkerShutdown(workerLock);

console.log("Local Director visual asset Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollMs}ms`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Task timeout: ${taskTimeoutMs}ms`);

let lastIdleLogAt = 0;
const activeTasks = new Set();

while (true) {
  try {
    runtimeHealth.assertHealthy();
    while (activeTasks.size < concurrency) {
      const task = await claimTask();
      if (!task) break;

      let taskPromise;
      taskPromise = processTask(task).finally(() => {
        activeTasks.delete(taskPromise);
      });
      activeTasks.add(taskPromise);
    }

    if (activeTasks.size === 0) {
      logIdle();
      await delay(pollMs);
      continue;
    }

    await Promise.race([...activeTasks, delay(pollMs)]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await delay(pollMs);
  }
}

async function processTask(task) {
  console.log(`Claimed visual asset task ${task.id} for @${task.entityKey}.`);
  try {
    await withCodexCliSlot("auxiliary", task.id, () => runCodex(task));
    await assertOutputFile(task.outputPath);
    const logPath = codexLogPath(task);
    const completed = await completeTask(task, {
      sourceImagePath: await extractSourceImagePathFromLog(logPath),
      codexLogPath: logPath,
    });
    console.log(`Completed visual asset task ${task.id}: ${completed.job?.task?.imageUrl || task.outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed visual asset task ${task.id}:`, failError);
    });
    console.error(`Visual asset task ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/visual-asset-image/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task, metadata) {
  return postJson(`/api/visual-asset-image/jobs/${encodeURIComponent(task.jobId)}/complete`, metadata);
}

async function failTask(task, message) {
  await postJson(`/api/visual-asset-image/jobs/${encodeURIComponent(task.jobId)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-visual-asset-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Visual asset Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "You are processing a Local Director project visual asset generation task.",
    "",
    "You MUST use Codex built-in image generation. Explicitly use $imagegen to generate the image.",
    "Do not ask the user to copy or paste anything. Do not open a browser. Do not call external image APIs.",
    "",
    `Task ID: ${task.id}`,
    `Job ID: ${task.jobId}`,
    `Asset: @${task.entityKey} ${task.entityName}`,
    `Asset type: ${task.assetType}`,
    `Entity type: ${task.entityType}`,
    `Mode: ${task.mode}`,
    `Size: ${task.size}`,
    `Quality: ${task.quality}`,
    `Output path: ${task.outputPath}`,
    "",
    "Image generation instructions:",
    task.prompt,
    "",
    "Completion requirements:",
    "1. Generate exactly one PNG image for this single project visual asset.",
    "2. Save the final PNG to the exact output path above.",
    "3. Create the output directory first if it does not exist.",
    "4. Verify the PNG exists and its file size is greater than zero.",
    "5. Print the final source image path in command output as SOURCE_IMAGE_PATH=<absolute path>.",
    "6. Final response must be exactly one line: DONE.",
  ].join("\n");
}

async function runCodex(task) {
  const messagePath = codexMessagePath(task);
  const logPath = codexLogPath(task);
  await fsp.mkdir(path.dirname(messagePath), { recursive: true });
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
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

  console.log(`Running codex exec for visual asset task ${task.id}.`);
  await new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n[${new Date().toISOString()}] codex exec started for ${task.id}\n`);
    let capturedOutput = "";
    const child = spawn(command, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        LOCALDIRECTOR_VISUAL_ASSET_TASK_ID: task.id,
        LOCALDIRECTOR_VISUAL_ASSET_JOB_ID: task.jobId,
      },
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      settle(new Error(buildCodexFailureMessage(`codex exec timed out after ${taskTimeoutMs}ms`, capturedOutput)));
    }, taskTimeoutMs);

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logStream.write(`[${new Date().toISOString()}] codex exec ${error ? "failed" : "finished"} for ${task.id}\n`);
      logStream.end();
      if (error) reject(error);
      else resolve();
    };

    child.stdout?.on("data", (chunk) => {
      capturedOutput = appendCapturedOutput(capturedOutput, chunk);
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      capturedOutput = appendCapturedOutput(capturedOutput, chunk);
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.stdin.end(buildCodexPrompt(task), "utf8");
    child.on("error", settle);
    child.on("exit", (code) => {
      if (timedOut) return;
      if (code === 0) settle();
      else settle(new Error(buildCodexFailureMessage(`codex exec exited with code ${code}`, capturedOutput)));
    });
  });
}

async function assertOutputFile(filePath) {
  const buffer = await fsp.readFile(filePath).catch(() => null);
  if (!buffer || buffer.length <= pngSignature.length) {
    throw new Error(`Output PNG is missing or empty: ${filePath}`);
  }
  if (!pngSignature.every((byte, index) => buffer[index] === byte)) {
    throw new Error(`Output file is not a PNG: ${filePath}`);
  }
}

async function extractSourceImagePathFromLog(logPath) {
  try {
    const logText = await fsp.readFile(logPath, "utf8");
    const joinedWrappedLines = logText.replace(/\r?\n\s+/g, "");
    const explicitMatch = /SOURCE_IMAGE_PATH=([A-Za-z]:\\[^\r\n"'<>|]+?\.png)/i.exec(joinedWrappedLines);
    if (explicitMatch) return explicitMatch[1];
    const generatedImagePaths = joinedWrappedLines.match(/[A-Za-z]:\\[^\r\n"'<>|]+?\.codex\\generated_images\\[^\r\n"'<>|]+?\.png/gi) || [];
    const fullPaths = generatedImagePaths.filter((item) => !item.includes("..."));
    return fullPaths.length ? fullPaths[fullPaths.length - 1] : null;
  } catch {
    return null;
  }
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

function codexLogPath(task) {
  return path.join(logDir, `${safeFileName(task.id)}.log`);
}

function resolveCodexCommand() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function shouldRunCodexThroughShell(command) {
  return process.platform === "win32" || /\.cmd$/i.test(command);
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function safeFileName(value) {
  return String(value || "task").replace(/[^\w.-]+/g, "-").slice(0, 160);
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function logIdle() {
  const now = Date.now();
  if (now - lastIdleLogAt < idleLogMs) return;
  lastIdleLogAt = now;
  console.log("No pending visual asset Codex tasks.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
