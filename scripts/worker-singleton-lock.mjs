import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export async function acquireWorkerFleetLock(name, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const lockRoot = path.join(rootDir, ".tmp-codex-runtime", "worker-locks");
  const lockPath = path.join(lockRoot, `${safeName(name)}.lock`);
  const ownerPath = path.join(lockPath, "owner.json");
  const pid = positiveInteger(options.pid, process.pid);
  const startTime = Number.isFinite(Number(options.startTime))
    ? Number(options.startTime)
    : Math.round(Date.now() - process.uptime() * 1_000);
  const commandHash = options.commandHash || createHash("sha256")
    .update(JSON.stringify({ execPath: process.execPath, argv: process.argv }))
    .digest("hex");
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  await fsp.mkdir(lockRoot, { recursive: true });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseId = randomUUID();
    const owner = {
      leaseId,
      name: safeName(name),
      pid,
      startTime,
      commandHash,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await fsp.mkdir(lockPath);
      await fsp.writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return {
        acquired: true,
        owner,
        release: () => releaseOwnedLock(lockPath, ownerPath, leaseId),
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existingOwner = await readOwner(ownerPath);
    if (existingOwner) {
      if (await Promise.resolve(isProcessAlive(existingOwner.pid, existingOwner.startTime))) {
        return {
          acquired: false,
          owner: existingOwner,
          release: async () => undefined,
        };
      }
      const verifiedOwner = await readOwner(ownerPath);
      if (!verifiedOwner || verifiedOwner.leaseId !== existingOwner.leaseId) {
        await delay(25);
        continue;
      }
    } else if (await isRecentDirectory(lockPath, 5_000)) {
      await delay(25);
      continue;
    }

    await fsp.rm(lockPath, { recursive: true, force: true });
  }

  throw new Error(`Could not acquire worker fleet singleton lock: ${safeName(name)}`);
}

async function isRecentDirectory(target, recentMs) {
  try {
    const info = await fsp.stat(target);
    return Date.now() - info.mtimeMs <= recentMs;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function releaseOwnedLock(lockPath, ownerPath, leaseId) {
  const current = await readOwner(ownerPath);
  if (!current || current.leaseId !== leaseId) return;
  await fsp.rm(lockPath, { recursive: true, force: true });
}

async function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultIsProcessAlive(pid, expectedStartTime) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  if (process.platform !== "win32" || !Number.isFinite(Number(expectedStartTime))) return true;
  try {
    const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const actualStartTime = Date.parse(execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    ).trim());
    return Number.isFinite(actualStartTime) && Math.abs(actualStartTime - Number(expectedStartTime)) < 5_000;
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeName(value) {
  return path.basename(String(value || "worker-fleet").replace(/[^a-zA-Z0-9._-]+/g, "-"));
}
