import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.STORYBOARD_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.STORYBOARD_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.STORYBOARD_CODEX_IDLE_LOG_MS, 30_000);
const concurrency = positiveInteger(process.env.STORYBOARD_CODEX_CONCURRENCY, 5);
const taskTimeoutMs = positiveInteger(process.env.STORYBOARD_CODEX_TASK_TIMEOUT_MS, 30 * 60_000);
const workerToken = process.env.STORYBOARD_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-storyboard-codex", "codex-messages");

console.log("Local Director storyboard Codex worker started.");
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollMs}ms`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Task timeout: ${taskTimeoutMs}ms`);

let lastIdleLogAt = 0;
const activeTasks = new Set();

while (true) {
  try {
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
  console.log(`Claimed storyboard panel ${task.id} for job ${task.jobId} (shot ${task.shotNumber}).`);
  try {
    await runCodex(task);
    await assertOutputFile(task.outputPath);
    await completeTask(task);
    console.log(`Completed storyboard panel ${task.id}: ${task.outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(task, message).catch((failError) => {
      console.error(`Could not report failed storyboard panel ${task.id}:`, failError);
    });
    console.error(`Storyboard panel ${task.id} failed: ${message}`);
  }
}

async function claimTask() {
  const data = await postJson("/api/storyboard-image/jobs/claim", {});
  return data.task || null;
}

async function completeTask(task) {
  await postJson(`/api/storyboard-image/jobs/${encodeURIComponent(task.jobId)}/panels/${encodeURIComponent(task.id)}/complete`, {});
}

async function failTask(task, message) {
  await postJson(`/api/storyboard-image/jobs/${encodeURIComponent(task.jobId)}/panels/${encodeURIComponent(task.id)}/fail`, { message });
}

async function postJson(pathname, body) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workerToken ? { "x-storyboard-codex-token": workerToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Storyboard Codex worker request failed: ${response.status}`);
  }
  return data;
}

function buildCodexPrompt(task) {
  return [
    "你正在处理 Local Director 的本地分镜图生成任务。",
    "",
    "必须使用 Codex 内置图片生成能力完成任务：请显式使用 $imagegen 生成图片。",
    "不要要求用户复制粘贴，不要打开浏览器，不要调用任何外部图片 API。",
    "",
    "任务信息：",
    `任务ID：${task.id}`,
    `Job ID：${task.jobId}`,
    `镜头编号：${task.shotNumber}`,
    `批次：第 ${task.batchIndex}/${task.batchTotal} 张`,
    `尺寸：${task.size}`,
    `质量：${task.quality}`,
    `输出路径：${task.outputPath}`,
    "",
    "图片生成说明：",
    task.prompt,
    "",
    "完成要求：",
    "1. 用上面的图片生成说明生成一张 PNG 图片。",
    "2. 这张图必须是单镜头分镜图，不要拼成多格，不要生成整张 storyboard sheet。",
    "3. 如果这是同一批里的多张图，请保持人物身份、服装、道具、光影和空间方向一致，但让这一张是独立镜头。",
    "4. 生成后把最终选定的 PNG 复制到输出路径，文件名和路径必须完全一致。",
    "5. 如果输出目录不存在，先创建目录。",
    "6. 保存后检查 PNG 文件存在且大小大于 0。",
    "7. 最终回复只写一行：DONE。",
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

  console.log(`Running codex exec for storyboard panel ${task.id}.`);
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

async function assertOutputFile(filePath) {
  const fileStat = await fsp.stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Codex did not produce a valid PNG file: ${filePath}`);
  }
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
  console.log("No pending storyboard Codex panel tasks.");
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeFileName(value) {
  return String(value || "task").replace(/[\\/:*?"<>|]+/g, "-");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
