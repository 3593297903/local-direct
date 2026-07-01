import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  claimNextVideoPromptCodexJob,
  completeVideoPromptCodexJob,
  createVideoPromptCodexJob,
  failVideoPromptCodexJob,
  getVideoPromptCodexJob,
} = require("../lib/video-prompt-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-video-prompt-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sampleAnalysisResult() {
  return {
    title: "早餐机器",
    contentType: "短剧",
    duration: "15秒",
    style: "未来科幻生活感",
    diagnosis: ["自动早餐机", "安静日常"],
    optimizedScript: "未来厨房里，早餐机自动制作吐司和咖啡。",
    workflow: {
      sourceAnalysis: "厨房晨间日常。",
      generationDiagnosis: {
        genre: "短剧",
        emotions: ["轻松"],
        sceneKeywords: ["厨房"],
        visualFocus: ["早餐机"],
        cameraStrategy: "中景到特写",
        avoid: ["血腥"],
      },
      screenplay: "林夏坐在餐桌前。",
      filmScript: "镜头按早餐流程推进。",
      fullVideoPrompt: "未来厨房里，早餐机自动制作吐司和咖啡。",
      fullNegativePrompt: "不要血腥。",
      concisePrompt: "未来厨房早餐机。",
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-3.0s",
        scene: "厨房",
        visual: "自动窗帘打开，早餐机启动。",
        shotType: "中景",
        composition: "eye-level medium shot with the table in the foreground",
        cameraMovement: "缓慢推进",
        lighting: "soft morning window light with clean blue projection glow",
        sound: "quiet kitchen ambience and gentle machine hum",
        dialogue: "无",
        emotion: "平静",
        transition: "硬切",
        shotPurpose: "establish the home routine and introduce the projection clue",
        firstFramePrompt: "未来厨房清晨。",
        videoPrompt: "未来厨房里早餐机启动，吐司机亮起。",
        lastFramePrompt: "吐司弹起。",
        negativePrompt: "不要血腥。",
      },
    ],
  };
}

test("creates, claims, and completes a local Codex video prompt job", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptCodexJob(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        script: "厨房里，早餐机自动制作吐司和咖啡。林夏坐在餐桌前，看着半空中的日程投影。",
        contentType: "短剧 / 通用",
        style: "未来科幻生活感",
        duration: "15秒",
      },
      { rootDir },
    );

    assert.equal(job.status, "pending");
    assert.match(job.id, /^video-prompt-job-/);
    assert.match(job.prompt, /strict JSON/);
    assert.match(job.prompt, /AnalysisResult/);
    assert.match(job.prompt, /optimizedScript/);
    assert.match(job.prompt, /workflow\.fullVideoPrompt/);
    assert.match(job.prompt, /storyboard/);
    assert.match(job.prompt, /composition/);
    assert.match(job.prompt, /lighting/);
    assert.match(job.prompt, /sound/);
    assert.match(job.prompt, /dialogue/);
    assert.match(job.prompt, /shotPurpose/);
    assert.doesNotMatch(job.prompt, /external API/i);
    assert.match(job.outputPath, /tmp-video-prompt-codex[\\/]results[\\/]video-prompt-job-/);
    assert.equal(job.result, null);

    const claimed = await claimNextVideoPromptCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed, "expected a pending video prompt job");
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");

    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(sampleAnalysisResult(), null, 2));

    const completed = await completeVideoPromptCodexJob(claimed.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.title, "早餐机器");
    assert.equal(completed.result.optimizedScript, "未来厨房里，早餐机自动制作吐司和咖啡。");

    const reloaded = await getVideoPromptCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.result.workflow.fullVideoPrompt, "未来厨房里，早餐机自动制作吐司和咖啡。");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stale running video prompt jobs can be reclaimed or failed", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptCodexJob(
      {
        script: "一个人走进旧楼，发现门缝里有一张照片。",
        duration: "15秒",
      },
      { rootDir },
    );

    const firstClaim = await claimNextVideoPromptCodexJob({ rootDir, order: "oldest" });
    assert.ok(firstClaim);
    assert.equal(firstClaim.status, "running");

    const jobPath = path.join(rootDir, ".tmp-video-prompt-codex", "jobs", `${job.id}.json`);
    const raw = JSON.parse(readFileSync(jobPath, "utf8"));
    raw.startedAt = new Date(Date.now() - 60_000).toISOString();
    raw.updatedAt = raw.startedAt;
    writeFileSync(jobPath, JSON.stringify(raw, null, 2));

    const reclaimed = await claimNextVideoPromptCodexJob({ rootDir, order: "oldest", runningTimeoutMs: 1 });
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, job.id);

    const failed = await failVideoPromptCodexJob(job.id, "codex failed", { rootDir });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "codex failed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("completes a Codex video prompt job when the output JSON starts with UTF-8 BOM", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptCodexJob(
      {
        script: "A woman enters a quiet kitchen and sees a floating calendar projection.",
        duration: "15 seconds",
      },
      { rootDir },
    );

    const claimed = await claimNextVideoPromptCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, `\uFEFF${JSON.stringify(sampleAnalysisResult(), null, 2)}`, "utf8");

    const completed = await completeVideoPromptCodexJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.storyboard.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects Codex video prompt JSON when storyboard production fields are missing", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptCodexJob(
      {
        script: "A teacher reads a note in an empty classroom.",
        duration: "15 seconds",
      },
      { rootDir },
    );

    const claimed = await claimNextVideoPromptCodexJob({ rootDir, order: "oldest" });
    assert.ok(claimed);

    const incomplete = sampleAnalysisResult();
    delete incomplete.storyboard[0].composition;
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify(incomplete, null, 2), "utf8");

    await assert.rejects(
      () => completeVideoPromptCodexJob(job.id, { rootDir }),
      /storyboard\[0\]\.composition/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
