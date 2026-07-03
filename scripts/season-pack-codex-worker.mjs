import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.SEASON_PACK_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.SEASON_PACK_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.SEASON_PACK_CODEX_IDLE_LOG_MS, 30_000);
const taskTimeoutMs = positiveInteger(process.env.SEASON_PACK_CODEX_TASK_TIMEOUT_MS, 60 * 60_000);
const workerToken = process.env.SEASON_PACK_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-season-pack-codex", "codex-messages");

console.log("Local Director season pack Codex worker started.");
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
  console.log(`Claimed season pack job ${task.id} (${task.episodeCount} episodes).`);
  try {
    await runCodex(task);
    await assertSeasonPackOutput(task);
    await completeTask(task);
    console.log(`Completed season pack job ${task.id}: ${task.packDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed season pack job ${task.id}:`, failError);
    });
    console.error(`Season pack job ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/season-pack/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task) {
  await postJson(`/api/season-pack/jobs/${encodeURIComponent(task.id)}/complete`, {});
}

async function failTask(task, message) {
  await postJson(`/api/season-pack/jobs/${encodeURIComponent(task.id)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-season-pack-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Season pack Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "You are running Local Director season planning from a local Codex CLI worker.",
    "The task prompt already contains the full source, output paths, and file-pack contract.",
    "This task must create Story Bible, Episode Chain, and Episode Input Packs only.",
    "Do not create final AnalysisResult JSON here.",
    "Follow it exactly. Do not call network providers. Do not open a browser. Do not ask for user input.",
    "After writing and validating the file pack, reply with exactly one line: DONE.",
    "",
    "Season pack task prompt:",
    task.prompt,
  ].join("\n");
}

async function runCodex(task) {
  const messagePath = codexMessagePath(task);
  await fsp.mkdir(path.dirname(messagePath), { recursive: true });
  const command = resolveCodexCommand();
  const args = buildCodexArgs(messagePath);

  console.log(`Running codex exec for season pack job ${task.id}.`);
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

function buildCodexArgs(messagePath) {
  const args = [
    "exec",
    "--cd",
    rootDir,
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "--output-last-message",
    messagePath,
  ];
  const model = process.env.SEASON_PACK_CODEX_MODEL?.trim();
  const profile = process.env.SEASON_PACK_CODEX_PROFILE?.trim();
  if (model) args.push("--model", model);
  if (profile) args.push("--profile", profile);
  args.push("-");
  return args;
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

async function assertSeasonPackOutput(task) {
  await assertJsonFile(task.manifestPath, "manifest.json");
  await assertJsonFile(task.seasonPlanPath, "season-plan.json");
  for (let episodeIndex = 1; episodeIndex <= task.episodeCount; episodeIndex += 1) {
    const fileName = `episode-${String(episodeIndex).padStart(3, "0")}.json`;
    const filePath = path.join(task.episodesDir, fileName);
    const raw = await assertJsonFile(filePath, fileName);
    const parsed = JSON.parse(stripJsonBom(raw));
    if (!parsed || typeof parsed !== "object") throw new Error(`${fileName} is not a JSON object`);
    for (const field of ["episodeIndex", "title", "sourceText", "duration", "contentType", "style", "storyBible", "episodeChain", "blueprint", "shotCount", "renderInputScript"]) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
        throw new Error(`${fileName} is missing ${field}`);
      }
    }
    if (Array.isArray(parsed.storyboard) || typeof parsed?.workflow?.fullVideoPrompt === "string") {
      throw new Error(`${fileName} must be an Episode Input Pack, not a final AnalysisResult`);
    }
    assertNoEncodingDamage(raw, `${task.script || ""}\n${task.prompt || ""}`);
  }
}

async function assertJsonFile(filePath, label) {
  const fileStat = await fsp.stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Codex did not produce ${label}: ${filePath}`);
  }
  const raw = stripJsonBom(await fsp.readFile(filePath, "utf8"));
  JSON.parse(raw);
  return raw;
}

function assertNoEncodingDamage(outputText, sourceText) {
  const sourceCjkCount = countCjkCharacters(sourceText);
  if (sourceCjkCount < 3) return;

  const questionMarkCount = countQuestionMarks(outputText);
  const replacementCharCount = countReplacementCharacters(outputText);
  const outputCjkCount = countCjkCharacters(outputText);

  if (replacementCharCount > 0) {
    throw new Error("Codex season pack output encoding appears damaged: replacement characters were found");
  }
  if (questionMarkCount >= 20 && questionMarkCount > Math.max(60, outputCjkCount * 2)) {
    throw new Error("Codex season pack output encoding appears damaged: excessive question marks in Chinese output");
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
  console.log("No pending season pack Codex jobs.");
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
