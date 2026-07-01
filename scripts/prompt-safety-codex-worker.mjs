import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.PROMPT_SAFETY_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.PROMPT_SAFETY_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.PROMPT_SAFETY_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.PROMPT_SAFETY_CODEX_TASK_TIMEOUT_MS, 20 * 60_000);
const workerToken = process.env.PROMPT_SAFETY_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-prompt-safety-codex", "codex-messages");

console.log("Local Director prompt safety Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollMs}ms`);
console.log(`Task timeout: ${taskTimeoutMs}ms`);

let lastIdleLogAt = 0;

while (true) {
  try {
    const task = await claimTask();
    if (!task) {
      logIdle();
      await delay(pollMs);
      continue;
    }

    await processTask(task);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await delay(pollMs);
  }
}

async function processTask(task) {
  console.log(`Claimed prompt safety job ${task.id}.`);
  try {
    await runCodex(task);
    await assertOutputJson(task.outputPath);
    await completeTask(task);
    console.log(`Completed prompt safety job ${task.id}: ${task.outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed prompt safety job ${task.id}:`, failError);
    });
    console.error(`Prompt safety job ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/prompt-safety/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task) {
  await postJson(`/api/prompt-safety/jobs/${encodeURIComponent(task.id)}/complete`, {});
}

async function failTask(task, message) {
  await postJson(`/api/prompt-safety/jobs/${encodeURIComponent(task.id)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-prompt-safety-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Prompt safety Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "You are running Local Director Seedance 2.0 prompt safety optimization from a local Codex CLI worker.",
    "Return strict JSON by writing a prompt safety optimization object to the output path.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "Do not evade moderation. Return strict word-level replacement patches only.",
    "",
    "The JSON must include targetModel, status, riskLevel, findings, changeSummary, and patches.",
    "Return patches only. Do not rewrite the full optimizedResult in the worker output.",
    "Each patch must include path, original, replacement, riskType, strategy, and severity when known.",
    "Each replacement must be the closest compliant word or short phrase, with no sentence expansion or explanation.",
    "The API will apply patches to the locked sourceResult and validate the final optimizedResult structure.",
    `Task ID: ${task.id}`,
    `Output path: ${task.outputPath}`,
    "",
    "Prompt safety optimization instructions:",
    task.prompt,
    "",
    "After writing and validating the JSON file, reply with exactly one line: DONE.",
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

  console.log(`Running codex exec for prompt safety job ${task.id}.`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: false,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`codex exec timed out after ${taskTimeoutMs}ms`));
    }, taskTimeoutMs);

    child.stdin.end(buildCodexPrompt(task), "utf8");
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(`codex exec exited with code ${code}`));
    });
  });
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

async function assertOutputJson(filePath) {
  const fileStat = await fsp.stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Codex did not produce a valid JSON file: ${filePath}`);
  }
  const result = JSON.parse(stripJsonBom(await fsp.readFile(filePath, "utf8")));
  if (!result || typeof result !== "object") throw new Error("Codex output JSON is not an object");
  if (typeof result.targetModel !== "string") throw new Error("Codex output JSON is missing targetModel");
  if (!Array.isArray(result.findings)) throw new Error("Codex output JSON is missing findings");
  if (!Array.isArray(result.changeSummary)) throw new Error("Codex output JSON is missing changeSummary");
  if (!Array.isArray(result.patches)) throw new Error("Codex output JSON is missing patches");
  result.patches.forEach((patch, index) => {
    if (!patch || typeof patch !== "object") throw new Error(`Codex output patch ${index} is not an object`);
    if (typeof patch.path !== "string" || !patch.path.trim()) throw new Error(`Codex output patch ${index} is missing path`);
    if (typeof patch.original !== "string" || !patch.original.trim()) throw new Error(`Codex output patch ${index} is missing original`);
    if (typeof patch.replacement !== "string" || !patch.replacement.trim()) {
      throw new Error(`Codex output patch ${index} is missing replacement`);
    }
  });
}

function resolveCodexCommand() {
  const explicit = process.env.CODEX_COMMAND?.trim();
  if (explicit) return explicit;
  if (process.platform !== "win32") return "codex";

  for (const candidate of windowsCodexCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "codex";
}

function stripJsonBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function shouldRunCodexThroughShell(command) {
  if (process.platform !== "win32") return false;
  return !/\.exe$/i.test(command);
}

function windowsCodexCandidates() {
  const pathEntries = String(process.env.Path || process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Roaming") : "");
  const npmBin = appData ? path.join(appData, "npm") : "";
  const searchDirs = [...new Set([...pathEntries, npmBin].filter(Boolean))];
  const names = ["codex.exe", "codex.cmd", "codex.bat", "codex"];
  return searchDirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function logIdle() {
  const now = Date.now();
  if (now - lastIdleLogAt < idleLogMs) return;
  lastIdleLogAt = now;
  console.log("No pending prompt safety Codex jobs.");
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileName(value) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
