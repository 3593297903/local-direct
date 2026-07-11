import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

const RUNTIME_DIR = ".tmp-codex-runtime";
const ENVIRONMENT_FILE = "environment.json";
const WORKER_DIR = "workers";
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_REVALIDATE_MS = 60_000;

export class CodexRuntimeInvalidError extends Error {
  constructor(health) {
    const details = health.errors.map((item) => `${item.path}: ${item.message}`).join("; ");
    super(`CODEX_SKILL_CONFIG_INVALID: ${details || "Codex runtime validation failed"}`);
    this.name = "CodexRuntimeInvalidError";
    this.code = "CODEX_SKILL_CONFIG_INVALID";
    this.health = health;
  }
}

export async function validateCodexRuntime(options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const configRoot = path.resolve(options.configRoot || resolveCodexHome());
  const skillRoots = (options.skillRoots || resolveSkillRoots(configRoot)).map((item) => path.resolve(item));
  const codexVersion = options.codexVersion || resolveCodexVersion();
  const skillFiles = (await Promise.all(skillRoots.map(listSkillFiles))).flat().sort();
  const errors = [];
  const fingerprintFiles = [];

  if (!codexVersion || codexVersion === "codex-unavailable") {
    errors.push(runtimeError("CODEX_CLI_UNAVAILABLE", configRoot, "Codex CLI is not available in the worker PATH"));
  }

  for (const filePath of skillFiles) {
    const fileStat = await stat(filePath);
    fingerprintFiles.push({ path: filePath, size: fileStat.size, mtimeMs: Math.round(fileStat.mtimeMs) });
    const source = await readFile(filePath, "utf8");
    errors.push(...validateSkillSource(filePath, source));
  }

  const runtimeFingerprint = createHash("sha256")
    .update(JSON.stringify({
      codexVersion,
      configRoot,
      skillRoots,
      files: fingerprintFiles,
      executablePath: process.env.PATH || "",
    }))
    .digest("hex");

  return {
    schemaVersion: 1,
    status: errors.length ? "invalid" : "healthy",
    checkedAt,
    codexVersion,
    configRoot,
    skillRoots,
    skillCount: skillFiles.length,
    runtimeFingerprint,
    errors,
  };
}

export async function writeCodexWorkerHeartbeat({
  rootDir = process.cwd(),
  workerName,
  health,
  heartbeatAt = new Date().toISOString(),
}) {
  const runtimeRoot = path.join(path.resolve(rootDir), RUNTIME_DIR);
  await mkdir(path.join(runtimeRoot, WORKER_DIR), { recursive: true });
  const worker = {
    schemaVersion: 1,
    workerName: normalizeWorkerName(workerName),
    pid: process.pid,
    heartbeatAt,
    runtimeFingerprint: health.runtimeFingerprint,
    status: health.status,
    environment: health,
  };
  await writeJsonAtomic(workerPath(runtimeRoot, worker.workerName, worker.pid), worker);
  return worker;
}

export async function writeCodexRuntimeEnvironmentHealth({
  rootDir = process.cwd(),
  health,
}) {
  const runtimeRoot = path.join(path.resolve(rootDir), RUNTIME_DIR);
  await mkdir(runtimeRoot, { recursive: true });
  await writeJsonAtomic(path.join(runtimeRoot, ENVIRONMENT_FILE), health);
  return health;
}

export async function readCodexRuntimeHealth({ rootDir = process.cwd(), workerName = "season-pack" } = {}) {
  const runtimeRoot = path.join(path.resolve(rootDir), RUNTIME_DIR);
  const normalizedWorkerName = normalizeWorkerName(workerName);
  const worker = await readLatestWorkerHeartbeat(runtimeRoot, normalizedWorkerName);
  return {
    environment: worker?.environment || await readJsonOrNull(path.join(runtimeRoot, ENVIRONMENT_FILE)),
    worker,
  };
}

export async function startCodexWorkerRuntimeHealth(workerName, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const revalidateMs = positiveInteger(options.revalidateMs, DEFAULT_REVALIDATE_MS);
  let currentHealth = await validateCodexRuntime(options);
  await writeCodexWorkerHeartbeat({ rootDir, workerName, health: currentHealth });
  if (currentHealth.status !== "healthy") throw new CodexRuntimeInvalidError(currentHealth);

  const heartbeatTimer = setInterval(() => {
    writeCodexWorkerHeartbeat({ rootDir, workerName, health: currentHealth }).catch((error) => {
      console.error(`Codex runtime heartbeat failed for ${workerName}:`, error);
    });
  }, heartbeatMs);
  heartbeatTimer.unref();

  const validationTimer = setInterval(async () => {
    try {
      currentHealth = await validateCodexRuntime(options);
      await writeCodexWorkerHeartbeat({ rootDir, workerName, health: currentHealth });
    } catch (error) {
      console.error(`Codex runtime revalidation failed for ${workerName}:`, error);
    }
  }, revalidateMs);
  validationTimer.unref();

  return {
    assertHealthy() {
      if (currentHealth.status !== "healthy") throw new CodexRuntimeInvalidError(currentHealth);
    },
    getHealth() {
      return currentHealth;
    },
    stop() {
      clearInterval(heartbeatTimer);
      clearInterval(validationTimer);
    },
  };
}

function validateSkillSource(filePath, rawSource) {
  const source = String(rawSource || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    return [runtimeError("MISSING_FRONTMATTER", filePath, "missing YAML frontmatter delimited by ---")];
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) {
    return [runtimeError("MISSING_FRONTMATTER", filePath, "missing closing YAML frontmatter delimiter ---")];
  }

  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), { prettyErrors: false, strict: true });
  if (document.errors.length) {
    return [runtimeError("INVALID_YAML", filePath, document.errors.map((item) => item.message).join("; "))];
  }
  const frontmatter = document.toJS();
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return [runtimeError("INVALID_YAML", filePath, "frontmatter must be a YAML mapping")];
  }
  const errors = [];
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name) errors.push(runtimeError("INVALID_NAME", filePath, "skill frontmatter is missing name"));
  if (!description) errors.push(runtimeError("INVALID_DESCRIPTION", filePath, "skill frontmatter is missing description"));
  if (description.length > 1024) {
    errors.push(runtimeError("DESCRIPTION_TOO_LONG", filePath, `description has ${description.length} characters; maximum is 1024`));
  }
  return errors;
}

async function listSkillFiles(rootPath) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) return listSkillFiles(entryPath);
      return entry.isFile() && entry.name === "SKILL.md" ? [entryPath] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function resolveCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolveSkillRoots(configRoot) {
  const explicit = String(process.env.CODEX_SKILL_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  return [path.join(configRoot, "skills"), path.join(configRoot, "plugins", "cache")];
}

function resolveCodexVersion() {
  const command = process.platform === "win32" ? "cmd.exe" : "codex";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "codex --version"] : ["--version"];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return "codex-unavailable";
  return String(result.stdout || result.stderr || "unknown").trim();
}

function runtimeError(code, filePath, message) {
  return { code, path: path.resolve(filePath), message: String(message || code).trim() };
}

function normalizeWorkerName(value) {
  const workerName = String(value || "").trim().toLowerCase();
  if (!workerName || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(workerName)) throw new Error("Invalid Codex worker name");
  return workerName;
}

function workerPath(runtimeRoot, workerName, pid) {
  return path.join(runtimeRoot, WORKER_DIR, `${workerName}.${pid}.json`);
}

async function readLatestWorkerHeartbeat(runtimeRoot, workerName) {
  const workerRoot = path.join(runtimeRoot, WORKER_DIR);
  const candidates = [];
  try {
    const fileNames = await readdir(workerRoot);
    for (const fileName of fileNames) {
      if (fileName !== `${workerName}.json` && !fileName.startsWith(`${workerName}.`)) continue;
      if (!fileName.endsWith(".json")) continue;
      const worker = await readJsonOrNull(path.join(workerRoot, fileName));
      if (worker?.workerName === workerName) candidates.push(worker);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return candidates.sort((left, right) => (
    Date.parse(right.heartbeatAt || "") - Date.parse(left.heartbeatAt || "")
  ))[0] || null;
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  await writeFile(temporary, payload, "utf8");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 3) {
        if (attempt === 3 && ["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
          await writeFile(target, payload, "utf8");
          await rm(temporary, { force: true });
          return;
        }
        await rm(temporary, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

async function readJsonOrNull(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
