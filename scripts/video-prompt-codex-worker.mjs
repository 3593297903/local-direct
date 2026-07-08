import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.VIDEO_PROMPT_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.VIDEO_PROMPT_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.VIDEO_PROMPT_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.VIDEO_PROMPT_CODEX_TASK_TIMEOUT_MS, 20 * 60_000);
const concurrency = Math.max(1, Math.min(5, positiveInteger(process.env.VIDEO_PROMPT_CODEX_CONCURRENCY, 3)));
const workerToken = process.env.VIDEO_PROMPT_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-video-prompt-codex", "codex-messages");

console.log("Local Director video prompt Codex worker started.");
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
  console.log(`Claimed video prompt job ${task.id}.`);
  try {
    await runCodex(task);
    await assertOutputJson(task.outputPath, task);
    await completeTask(task);
    console.log(`Completed video prompt job ${task.id}: ${task.outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed video prompt job ${task.id}:`, failError);
    });
    console.error(`Video prompt job ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/video-prompt/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task) {
  await postJson(`/api/video-prompt/jobs/${encodeURIComponent(task.id)}/complete`, {});
}

async function failTask(task, message) {
  await postJson(`/api/video-prompt/jobs/${encodeURIComponent(task.id)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-video-prompt-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Video prompt Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "You are running Local Director video prompt generation from a local Codex CLI worker.",
    "Return strict JSON by writing a Local Director complete video prompt result object to the output path.",
    "Do not call network providers. Do not open a browser. Do not ask the user for follow-up input.",
    "Write the JSON file as UTF-8. Prefer Node.js fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), \"utf8\").",
    "Do not use PowerShell Set-Content, Out-File, shell redirection, or here-strings for Chinese text.",
    "After writing, read the file back as UTF-8 and confirm Chinese characters are preserved, not replaced by question marks.",
    "",
    "The JSON must include optimizedScript, workflow.fullVideoPrompt, workflow.concisePrompt, and storyboard.",
    `Task ID: ${task.id}`,
    `Output path: ${task.outputPath}`,
    "",
    "Video prompt generation instructions:",
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

  console.log(`Running codex exec for video prompt job ${task.id}.`);
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

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

async function assertOutputJson(filePath, task) {
  const fileStat = await fsp.stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Codex did not produce a valid JSON file: ${filePath}`);
  }
  const raw = stripJsonBom(await fsp.readFile(filePath, "utf8"));
  const result = JSON.parse(raw);
  if (!result || typeof result !== "object") throw new Error("Codex output JSON is not an object");
  if (typeof result.optimizedScript !== "string") throw new Error("Codex output JSON is missing optimizedScript");
  if (!result.workflow || typeof result.workflow.fullVideoPrompt !== "string") {
    throw new Error("Codex output JSON is missing workflow.fullVideoPrompt");
  }
  if (!Array.isArray(result.storyboard) || result.storyboard.length < 1) {
    throw new Error("Codex output JSON is missing storyboard");
  }
  assertNoEncodingDamage(raw, `${task?.script || ""}\n${task?.prompt || ""}`);
}

function assertNoEncodingDamage(outputText, sourceText) {
  const sourceCjkCount = countCjkCharacters(sourceText);
  if (sourceCjkCount < 3) return;

  const questionMarkCount = countQuestionMarks(outputText);
  const replacementCharCount = countReplacementCharacters(outputText);
  const outputCjkCount = countCjkCharacters(outputText);

  if (replacementCharCount > 0) {
    throw new Error("Codex output encoding appears damaged: replacement characters were found");
  }
  if (questionMarkCount >= 20 && questionMarkCount > Math.max(60, outputCjkCount * 2)) {
    throw new Error("Codex output encoding appears damaged: excessive question marks in Chinese output");
  }
}

function countCjkCharacters(value) {
  return (String(value || "").match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
}

function countQuestionMarks(value) {
  return (String(value || "").match(/\?/g) || []).length;
}

function countReplacementCharacters(value) {
  return (String(value || "").match(/\ufffd/g) || []).length;
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
  console.log("No pending video prompt Codex jobs.");
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
