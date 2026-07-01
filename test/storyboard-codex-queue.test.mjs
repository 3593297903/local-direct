import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  claimNextStoryboardCodexPanel,
  completeStoryboardCodexPanel,
  createStoryboardCodexJob,
  getStoryboardCodexJob,
} = require("../lib/storyboard-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-storyboard-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function pngHeader(width = 1024, height = 576) {
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

const sampleStoryboard = [
  {
    shotNumber: 1,
    scene: "雨夜旧楼门口",
    visual: "男人握着旧照片站在废弃大楼门外，雨水打湿袖口。",
    shotType: "中景",
    cameraMovement: "缓慢推进",
    emotion: "不安",
    transition: "硬切",
    videoPrompt: "雨夜，男人站在废弃大楼门外看旧照片。",
    negativePrompt: "不要血腥，不要鬼脸。",
  },
  {
    shotNumber: 2,
    scene: "楼道",
    visual: "手电光扫过墙面水痕，照片背面的地址被再次特写。",
    shotType: "特写",
    cameraMovement: "手持跟拍",
    emotion: "紧张",
    transition: "动作匹配",
    videoPrompt: "手电光扫过墙面，地址线索被特写。",
    negativePrompt: "不要额外人物，不要夸张怪物。",
  },
];

test("creates one Codex storyboard panel task for each shot", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createStoryboardCodexJob(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        title: "雨夜旧照",
        style: "黑白铅笔电影分镜",
        storyboard: sampleStoryboard,
      },
      { rootDir },
    );

    assert.equal(job.status, "pending");
    assert.equal(job.panels.length, 2);
    assert.deepEqual(job.panels.map((panel) => panel.status), ["pending", "pending"]);
    assert.deepEqual(job.panels.map((panel) => panel.shotNumber), [1, 2]);
    assert.match(job.panels[0].prompt, /Create ONE single cinematic production storyboard frame/);
    assert.match(job.panels[0].prompt, /cinematic production storyboard frame/);
    assert.match(job.panels[0].prompt, /full color/);
    assert.match(job.panels[0].prompt, /based directly on the shot video prompt/);
    assert.doesNotMatch(job.panels[0].prompt, /grayscale pencil sketch/);
    assert.doesNotMatch(job.panels[0].prompt, /label in the top-left/);
    assert.match(job.panels[0].prompt, /雨夜旧楼门口/);
    assert.match(job.panels[0].outputPath, /public[\\/]project-assets[\\/]storyboards/);
    assert.equal(job.panels[0].imageUrl, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claiming and completing panel tasks stores panel URLs without generating a legacy sheet", async () => {
  const rootDir = makeTempRoot();
  try {
    mkdirSync(rootDir, { recursive: true });
    const job = await createStoryboardCodexJob(
      {
        projectId: "33333333-3333-4333-8333-333333333333",
        versionId: "44444444-4444-4444-8444-444444444444",
        title: "楼道线索",
        style: "专业电影分镜",
        storyboard: sampleStoryboard,
      },
      { rootDir },
    );

    for (let index = 0; index < sampleStoryboard.length; index += 1) {
      const panel = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest" });
      assert.ok(panel, "expected a pending panel to claim");
      assert.equal(panel.jobId, job.id);
      mkdirSync(path.dirname(panel.outputPath), { recursive: true });
      writeFileSync(panel.outputPath, Buffer.concat([pngHeader(), Buffer.from(`panel-${index}`)]));
      const updated = await completeStoryboardCodexPanel(panel.jobId, panel.id, { rootDir });
      assert.equal(updated.panels[index].status, "completed");
    }

    const completed = await getStoryboardCodexJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.sheetUrl, null);
    assert.ok(completed.panels.every((panel) => panel.imageUrl?.endsWith(".png")));
    assert.equal(existsSync(completed.sheetPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("complete rejects missing, non-PNG, and wrong-size storyboard panel outputs", async () => {
  const rootDir = makeTempRoot();
  try {
    mkdirSync(rootDir, { recursive: true });
    const job = await createStoryboardCodexJob(
      {
        projectId: "33333333-3333-4333-8333-333333333333",
        versionId: "44444444-4444-4444-8444-444444444444",
        title: "尺寸校验",
        style: "专业电影分镜",
        storyboard: sampleStoryboard.slice(0, 1),
      },
      { rootDir },
    );

    const panel = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest" });
    assert.ok(panel, "expected a pending panel to claim");

    await assert.rejects(
      () => completeStoryboardCodexPanel(job.id, panel.id, { rootDir }),
      /valid storyboard image/,
    );

    mkdirSync(path.dirname(panel.outputPath), { recursive: true });
    writeFileSync(panel.outputPath, Buffer.from("png-bytes"));
    await assert.rejects(
      () => completeStoryboardCodexPanel(job.id, panel.id, { rootDir }),
      /valid storyboard image/,
    );

    writeFileSync(panel.outputPath, pngHeader(1672, 941));
    await assert.rejects(
      () => completeStoryboardCodexPanel(job.id, panel.id, { rootDir }),
      /valid storyboard image/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("complete returns duplicate storyboard panel outputs to pending for retry", async () => {
  const rootDir = makeTempRoot();
  try {
    mkdirSync(rootDir, { recursive: true });
    const job = await createStoryboardCodexJob(
      {
        projectId: "33333333-3333-4333-8333-333333333333",
        versionId: "44444444-4444-4444-8444-444444444444",
        title: "骞跺彂涓插浘",
        style: "涓撲笟鐢靛奖鍒嗛暅",
        storyboard: sampleStoryboard,
      },
      { rootDir },
    );

    const sourceImagePath = "C:\\Users\\Administrator\\.codex\\generated_images\\same-source\\ig_same.png";

    const firstPanel = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest" });
    assert.ok(firstPanel, "expected first panel to claim");
    mkdirSync(path.dirname(firstPanel.outputPath), { recursive: true });
    writeFileSync(firstPanel.outputPath, Buffer.concat([pngHeader(), Buffer.from("first")]));
    const firstCompleted = await completeStoryboardCodexPanel(firstPanel.jobId, firstPanel.id, {
      rootDir,
      sourceImagePath,
    });
    assert.equal(firstCompleted.panels[0].status, "completed");

    const secondPanel = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest" });
    assert.ok(secondPanel, "expected second panel to claim");
    writeFileSync(secondPanel.outputPath, Buffer.concat([pngHeader(), Buffer.from("second")]));
    const secondUpdated = await completeStoryboardCodexPanel(secondPanel.jobId, secondPanel.id, {
      rootDir,
      sourceImagePath,
    });

    const retriedPanel = secondUpdated.panels.find((panel) => panel.id === secondPanel.id);
    assert.equal(retriedPanel.status, "pending");
    assert.match(retriedPanel.error, /duplicate/i);
    assert.equal(existsSync(secondPanel.outputPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stale running panel tasks are reclaimed after the running timeout", async () => {
  const rootDir = makeTempRoot();
  try {
    mkdirSync(rootDir, { recursive: true });
    const job = await createStoryboardCodexJob(
      {
        projectId: "55555555-5555-4555-8555-555555555555",
        versionId: "66666666-6666-4666-8666-666666666666",
        title: "超时重试",
        style: "专业电影分镜",
        storyboard: sampleStoryboard.slice(0, 1),
      },
      { rootDir },
    );

    const firstClaim = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest" });
    assert.ok(firstClaim, "expected the first panel to be claimed");
    assert.equal(firstClaim.status, "running");

    const jobPath = path.join(rootDir, ".tmp-storyboard-codex", "jobs", `${job.id}.json`);
    const saved = JSON.parse(readFileSync(jobPath, "utf8"));
    saved.panels[0].startedAt = "2020-01-01T00:00:00.000Z";
    saved.panels[0].updatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(jobPath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

    const reclaimed = await claimNextStoryboardCodexPanel({ rootDir, order: "oldest", runningTimeoutMs: 1 });
    assert.ok(reclaimed, "expected stale running task to become claimable again");
    assert.equal(reclaimed.id, firstClaim.id);
    assert.equal(reclaimed.status, "running");
    assert.notEqual(reclaimed.startedAt, "2020-01-01T00:00:00.000Z");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("storyboard queue serializes JSON mutations with a filesystem lock", () => {
  const source = readFileSync("lib/storyboard-codex-queue.ts", "utf8");

  assert.match(source, /QUEUE_LOCK_DIR/);
  assert.match(source, /withQueueLock/);
  assert.match(source, /claimNextStoryboardCodexPanel[\s\S]*withQueueLock/);
  assert.match(source, /completeStoryboardCodexPanel[\s\S]*withQueueLock/);
  assert.match(source, /failStoryboardCodexPanel[\s\S]*withQueueLock/);
});
