import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.VIDEO_PROMPT_PACK_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_TASK_TIMEOUT_MS, 30 * 60_000);
const concurrency = Math.max(1, Math.min(4, positiveInteger(process.env.VIDEO_PROMPT_PACK_CODEX_CONCURRENCY, 3)));
const workerToken = process.env.VIDEO_PROMPT_PACK_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-video-prompt-pack-codex", "codex-messages");

console.log("Local Director video prompt Render Pack Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollMs}ms`);
console.log(`Task timeout: ${taskTimeoutMs}ms`);
console.log(`Concurrency: ${concurrency}`);

let lastIdleLogAt = 0;
const activeTasks = new Set();

while (true) {
  try {
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
  try {
    await runCodex(task);
    await assertOutputJsonFiles(task);
    await completeTask(task);
    console.log(`Completed video prompt Render Pack job ${task.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed video prompt Render Pack job ${task.id}:`, failError);
    });
    console.error(`Video prompt Render Pack job ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/video-prompt-packs/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task) {
  await postJson(`/api/video-prompt-packs/jobs/${encodeURIComponent(task.id)}/complete`, {});
}

async function failTask(task, message) {
  await postJson(`/api/video-prompt-packs/jobs/${encodeURIComponent(task.id)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-video-prompt-pack-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Video prompt Render Pack Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "You are running Local Director video prompt Render Pack generation from a local Codex CLI worker.",
    "The task prompt already contains every segment render script and exact output paths.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "Write each segment as its own complete Local Director AnalysisResult JSON file.",
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
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(buildCodexFailureMessage(`codex exec exited with code ${code}`, capturedOutput)));
    });
  });
}

async function assertOutputJsonFiles(task) {
  for (const segment of task.segments || []) {
    const fileStat = await fsp.stat(segment.outputPath);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new Error(`Codex did not produce a valid segment JSON file: ${segment.outputPath}`);
    }
    const result = JSON.parse(stripJsonBom(await fsp.readFile(segment.outputPath, "utf8")));
    if (!result || typeof result !== "object") throw new Error(`Codex output JSON is not an object: ${segment.outputPath}`);
    if (typeof result.optimizedScript !== "string") throw new Error(`Codex output JSON is missing optimizedScript: ${segment.outputPath}`);
    if (!result.workflow || typeof result.workflow.fullVideoPrompt !== "string") {
      throw new Error(`Codex output JSON is missing workflow.fullVideoPrompt: ${segment.outputPath}`);
    }
    if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
      throw new Error(`Codex output JSON is missing storyboard: ${segment.outputPath}`);
    }
  }
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

function stripJsonBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
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
