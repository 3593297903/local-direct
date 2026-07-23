import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const { atomicReplaceJson } = require("../lib/file-job-store.ts");

test("atomic JSON replacement retries Windows sharing violations without partial output", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-atomic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const target = path.join(rootDir, "queue", "job.json");
  let attempts = 0;
  try {
    await atomicReplaceJson(target, { ok: true, revision: 2 }, {
      rootDir,
      retryDelaysMs: [0, 0, 0, 0],
      renameImpl: async (source, destination) => {
        attempts += 1;
        if (attempts < 4) {
          const error = new Error("busy");
          error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EACCES" : "EBUSY";
          throw error;
        }
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
      },
    });
    assert.equal(attempts, 4);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ok: true, revision: 2 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("atomic JSON replacement rejects targets outside the queue root", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-atomic-root-${Date.now()}`);
  await assert.rejects(
    () => atomicReplaceJson(path.join(rootDir, "..", "escape.json"), { unsafe: true }, { rootDir }),
    /outside|root/i,
  );
});

test("permanent Windows sharing violations preserve the previous job and leave no partial file", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-atomic-busy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const queueDir = path.join(rootDir, "queue");
  const target = path.join(queueDir, "job.json");
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(target, JSON.stringify({ revision: 1 }), "utf8");
  try {
    await assert.rejects(
      () => atomicReplaceJson(target, { revision: 2 }, {
        rootDir,
        retryDelaysMs: [0, 0, 0, 0],
        renameImpl: async () => {
          const error = new Error("busy");
          error.code = "EBUSY";
          throw error;
        },
      }),
      (error) => error?.code === "JOB_STORAGE_BUSY",
    );
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { revision: 1 });
    assert.deepEqual(readdirSync(queueDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
