import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendCapturedOutput, buildCodexFailureMessage } from "./codex-runtime-utils.mjs";
import { withCodexCliSlot } from "./codex-cli-slot-coordinator.mjs";
import { startCodexWorkerRuntimeHealth } from "./codex-runtime-health.mjs";
import { acquireWorkerFleetLock } from "./worker-singleton-lock.mjs";

const rootDir = process.cwd();
const apiBaseUrl = (process.env.STORYBOARD_CODEX_API_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const pollMs = positiveInteger(process.env.STORYBOARD_CODEX_POLL_MS, 2500);
const idleLogMs = positiveInteger(process.env.STORYBOARD_CODEX_IDLE_LOG_MS, 30_000);
const concurrency = positiveInteger(process.env.STORYBOARD_CODEX_CONCURRENCY, 5);
const taskTimeoutMs = positiveInteger(process.env.STORYBOARD_CODEX_TASK_TIMEOUT_MS, 30 * 60_000);
const workerToken = process.env.STORYBOARD_CODEX_WORKER_TOKEN || "";
const messageDir = path.join(rootDir, ".tmp-storyboard-codex", "codex-messages");
const logDir = path.join(rootDir, ".tmp-storyboard-codex", "codex-logs");
const sourceManifestDir = path.join(rootDir, ".tmp-storyboard-codex", "source-manifests");
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const workerLock = await acquireWorkerFleetLock("storyboard-worker", { rootDir });
if (!workerLock.acquired) {
  console.log(`Storyboard worker is already running (pid=${workerLock.owner?.pid || "unknown"}).`);
  process.exit(0);
}
const runtimeHealth = await startCodexWorkerRuntimeHealth("storyboard", { rootDir });
installWorkerShutdown(workerLock);

console.log("Local Director storyboard Codex worker started.");
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
  console.log(`Claimed storyboard panel ${task.id} for job ${task.jobId} (shot ${task.shotNumber}).`);
  try {
    await withCodexCliSlot("visual_asset", task.id, () => runCodex(task));
    await normalizePngToExpectedSize(task.outputPath, task.size);
    await assertOutputFile(task.outputPath, task.size);
    const metadata = await buildCompletionMetadata(task);
    const completed = await completeTask(task, metadata);
    const panelStatus = completed.job?.panels?.find((panel) => panel.id === task.id)?.status;
    if (panelStatus === "completed") {
      console.log(`Completed storyboard panel ${task.id}: ${task.outputPath}`);
    } else if (panelStatus === "pending") {
      console.warn(`Storyboard panel ${task.id} was detected as duplicate and returned to pending for retry.`);
    } else if (panelStatus === "failed") {
      console.error(`Storyboard panel ${task.id} was marked failed after duplicate checks.`);
    }
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

async function completeTask(task, metadata) {
  return postJson(
    `/api/storyboard-image/jobs/${encodeURIComponent(task.jobId)}/panels/${encodeURIComponent(task.id)}/complete`,
    metadata,
  );
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
    `6. 保存后的 PNG 像素尺寸必须严格等于 ${task.size}，横向 16:9。`,
    "7. 保存后检查 PNG 文件存在且大小大于 0。",
    "8. 保存时请在命令输出里打印最终源图路径，格式为：SOURCE_IMAGE_PATH=<absolute path>。",
    "9. 不要复用同批次其他镜头已经保存过的图片；如果发现抓错了其他镜头的图片，必须重新生成。",
    "10. 最终回复只写一行：DONE。",
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

  console.log(`Running codex exec for storyboard panel ${task.id}.`);
  await new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n[${new Date().toISOString()}] codex exec started for ${task.id}\n`);
    let capturedOutput = "";
    const child = spawn(command, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        LOCALDIRECTOR_STORYBOARD_TASK_ID: task.id,
        LOCALDIRECTOR_STORYBOARD_JOB_ID: task.jobId,
      },
      shell: shouldRunCodexThroughShell(command),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logStream.write(`[${new Date().toISOString()}] codex exec ${error ? "failed" : "finished"} for ${task.id}\n`);
      logStream.end();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      settle(new Error(buildCodexFailureMessage(`codex exec timed out after ${taskTimeoutMs}ms`, capturedOutput)));
    }, taskTimeoutMs);

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
    child.on("error", (error) => {
      settle(error);
    });
    child.on("exit", (code) => {
      if (timedOut) return;
      if (code === 0) settle();
      else settle(new Error(buildCodexFailureMessage(`codex exec exited with code ${code}`, capturedOutput)));
    });
  });
}

function codexMessagePath(task) {
  return path.join(messageDir, `${safeFileName(task.id)}.txt`);
}

function codexLogPath(task) {
  return path.join(logDir, `${safeFileName(task.id)}.log`);
}

function sourceManifestPath(task) {
  return path.join(sourceManifestDir, `${safeFileName(task.id)}.json`);
}

async function buildCompletionMetadata(task) {
  const logPath = codexLogPath(task);
  const metadata = {
    sourceImagePath: await extractSourceImagePathFromLog(logPath),
    imageFingerprint: await computeImageFingerprint(task.outputPath).catch((error) => {
      console.warn(`Could not compute image fingerprint for ${task.id}:`, error instanceof Error ? error.message : error);
      return null;
    }),
    codexLogPath: logPath,
  };

  await fsp.mkdir(path.dirname(sourceManifestPath(task)), { recursive: true });
  await fsp.writeFile(
    sourceManifestPath(task),
    `${JSON.stringify({ taskId: task.id, jobId: task.jobId, outputPath: task.outputPath, ...metadata }, null, 2)}\n`,
    "utf8",
  );

  return metadata;
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
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not read Codex log for source image extraction: ${error instanceof Error ? error.message : error}`);
    }
    return null;
  }
}

async function computeImageFingerprint(filePath) {
  if (process.platform !== "win32") return null;

  const script = [
    `Add-Type -AssemblyName System.Drawing`,
    `$path = ${powerShellString(filePath)}`,
    `$src = [System.Drawing.Image]::FromFile($path)`,
    `$bmp = [System.Drawing.Bitmap]::new(32, 18)`,
    `$graphics = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$hex = New-Object System.Text.StringBuilder`,
    `try {`,
    `  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic`,
    `  $graphics.DrawImage($src, 0, 0, 32, 18)`,
    `  for ($y = 0; $y -lt 18; $y++) {`,
    `    for ($x = 0; $x -lt 32; $x++) {`,
    `      $pixel = $bmp.GetPixel($x, $y)`,
    `      $gray = [int](($pixel.R * 0.299) + ($pixel.G * 0.587) + ($pixel.B * 0.114))`,
    `      [void]$hex.Append($gray.ToString("x2"))`,
    `    }`,
    `  }`,
    `  $hex.ToString()`,
    `} finally {`,
    `  $graphics.Dispose()`,
    `  $bmp.Dispose()`,
    `  $src.Dispose()`,
    `}`,
  ].join("; ");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.replace(/[^a-f0-9]/gi, "").toLowerCase() || null);
      else reject(new Error(`Image fingerprint failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function normalizePngToExpectedSize(filePath, expectedSize) {
  const expected = parseImageSize(expectedSize);
  const actual = await readPngDimensions(filePath);
  if (!actual) throw new Error(`Codex did not produce a readable PNG file: ${filePath}`);
  if (actual.width === expected.width && actual.height === expected.height) return;

  if (process.platform !== "win32") {
    throw new Error(
      `Codex produced ${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}: ${filePath}`,
    );
  }

  await resizePngWithPowerShell(filePath, expected.width, expected.height);
}

async function resizePngWithPowerShell(filePath, width, height) {
  const tmpPath = `${filePath}.normalized-${process.pid}.png`;
  const script = [
    `Add-Type -AssemblyName System.Drawing`,
    `$src = ${powerShellString(filePath)}`,
    `$tmp = ${powerShellString(tmpPath)}`,
    `$targetWidth = ${width}`,
    `$targetHeight = ${height}`,
    `$srcBitmap = [System.Drawing.Image]::FromFile($src)`,
    `$destBitmap = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight)`,
    `$graphics = [System.Drawing.Graphics]::FromImage($destBitmap)`,
    `try {`,
    `  $graphics.Clear([System.Drawing.Color]::Black)`,
    `  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality`,
    `  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic`,
    `  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality`,
    `  $graphics.DrawImage($srcBitmap, 0, 0, $targetWidth, $targetHeight)`,
    `  $destBitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `} finally {`,
    `  $graphics.Dispose()`,
    `  $destBitmap.Dispose()`,
    `  $srcBitmap.Dispose()`,
    `}`,
    `Move-Item -LiteralPath $tmp -Destination $src -Force`,
  ].join("; ");

  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PNG resize failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function assertOutputFile(filePath, expectedSize = "1024x576") {
  const fileStat = await fsp.stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Codex did not produce a valid PNG file: ${filePath}`);
  }
  const expected = parseImageSize(expectedSize);
  const actual = await readPngDimensions(filePath);
  if (!actual || actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`Codex did not produce a ${expected.width}x${expected.height} PNG file: ${filePath}`);
  }
}

async function readPngDimensions(filePath) {
  const buffer = await fsp.readFile(filePath);
  if (buffer.length < 33) return null;
  if (!pngSignature.every((byte, index) => buffer[index] === byte)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseImageSize(size) {
  const match = /^(\d+)x(\d+)$/i.exec(String(size || "1024x576"));
  if (!match) return { width: 1024, height: 576 };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function powerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function terminateProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill();
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
