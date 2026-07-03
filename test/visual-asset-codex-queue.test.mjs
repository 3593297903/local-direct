import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  claimNextVisualAssetCodexTask,
  completeVisualAssetCodexTask,
  createVisualAssetCodexJob,
  failVisualAssetCodexTask,
  getVisualAssetCodexJob,
} = require("../lib/visual-asset-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-visual-asset-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function pngHeader(width = 1024, height = 1024) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

const baseInput = {
  projectId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  entityId: "33333333-3333-4333-8333-333333333333",
  entityType: "CHARACTER",
  entityName: "林夏",
  entityKey: "lin_xia",
  canonicalPrompt: "30岁女性，黑发，浅灰职业装，疲惫但克制。",
  visualLock: "保持同一张脸、发型、年龄、服装和气质。",
  negativeLock: "不要学生感，不要夸张妆容，不要换衣服。",
};

test("creates a character visual asset Codex job with one turnaround task", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVisualAssetCodexJob(baseInput, { rootDir });

    assert.equal(job.status, "pending");
    assert.match(job.id, /^visual-asset-job-/);
    assert.equal(job.task.status, "pending");
    assert.equal(job.task.assetType, "CHARACTER_TURNAROUND");
    assert.equal(job.task.entityType, "CHARACTER");
    assert.equal(job.task.entityName, "林夏");
    assert.match(job.task.prompt, /character turnaround reference sheet/i);
    assert.match(job.task.prompt, /@lin_xia/);
    assert.match(job.task.outputPath, /public[\\/]project-assets[\\/]visual-assets/);
    assert.equal(job.task.imageUrl, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claims and completes a visual asset task with a saved PNG url", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVisualAssetCodexJob(baseInput, { rootDir });
    const task = await claimNextVisualAssetCodexTask({ rootDir });
    assert.ok(task);
    assert.equal(task.id, job.task.id);
    assert.equal(task.status, "running");

    mkdirSync(path.dirname(task.outputPath), { recursive: true });
    writeFileSync(task.outputPath, Buffer.concat([pngHeader(), Buffer.from("visual-asset")]));

    const completed = await completeVisualAssetCodexTask(job.id, {
      rootDir,
      sourceImagePath: "C:\\Users\\Administrator\\.codex\\generated_images\\asset.png",
      codexLogPath: "E:\\localdirector\\.tmp-visual-asset-codex\\codex-logs\\asset.log",
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.task.status, "completed");
    assert.ok(completed.task.imageUrl?.endsWith(".png"));
    assert.equal(completed.task.sourceImagePath, "C:\\Users\\Administrator\\.codex\\generated_images\\asset.png");

    const reloaded = await getVisualAssetCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.task.imageUrl, completed.task.imageUrl);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("failed visual asset tasks retry before final failure", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVisualAssetCodexJob(baseInput, { rootDir });
    const firstClaim = await claimNextVisualAssetCodexTask({ rootDir });
    assert.ok(firstClaim);

    const firstFailure = await failVisualAssetCodexTask(job.id, "temporary Codex error", { rootDir });
    assert.equal(firstFailure.status, "pending");
    assert.equal(firstFailure.task.status, "pending");

    const secondClaim = await claimNextVisualAssetCodexTask({ rootDir });
    assert.ok(secondClaim);
    const secondFailure = await failVisualAssetCodexTask(job.id, "temporary Codex error", { rootDir });
    assert.equal(secondFailure.status, "pending");
    assert.equal(secondFailure.task.status, "pending");

    const thirdClaim = await claimNextVisualAssetCodexTask({ rootDir });
    assert.ok(thirdClaim);
    const finalFailure = await failVisualAssetCodexTask(job.id, "temporary Codex error", { rootDir });
    assert.equal(finalFailure.status, "failed");
    assert.equal(finalFailure.task.status, "failed");
    assert.match(finalFailure.error, /temporary Codex error/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
