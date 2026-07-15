import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
  createSeasonPackCodexJob,
  getSeasonPackCodexJob,
} = require("../lib/season-pack-codex-queue.ts");
const {
  createVideoPromptPackCodexJob,
  getVideoPromptPackCodexJob,
} = require("../lib/video-prompt-pack-codex-queue.ts");

const STATUSES = ["pending", "running", "completed", "failed"];

function makeTempRoot(label) {
  return path.join(os.tmpdir(), `localdirector-v1-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function snapshotFiles(rootDir) {
  const output = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else output.push([path.relative(rootDir, target), readFileSync(target, "utf8")]);
    }
  }
  visit(rootDir);
  return output.sort(([left], [right]) => left.localeCompare(right));
}

function legacyResult(label) {
  return {
    title: label,
    contentType: "短剧",
    duration: "12秒",
    style: "写实",
    diagnosis: ["完整"],
    optimizedScript: `${label} 文案`,
    workflow: {
      sourceAnalysis: "来源分析",
      screenplay: "剧本",
      filmScript: "拍摄脚本",
      fullVideoPrompt: `${label} 完整视频提示词`,
      fullNegativePrompt: "避免水印和文字错误",
      concisePrompt: `${label} 简洁提示词`,
    },
    storyboard: [{
      shotNumber: 1,
      timeRange: "0-3秒",
      scene: "室内",
      visual: "人物在室内完成清晰动作",
      shotType: "中景",
      composition: "平视构图",
      cameraMovement: "缓慢推进",
      lighting: "自然侧光",
      sound: "环境声",
      dialogue: "无",
      emotion: "克制",
      transition: "硬切",
      shotPurpose: "建立空间",
      firstFramePrompt: "人物位于室内的首帧",
      videoPrompt: "镜头缓慢推进，人物在自然侧光下完成动作",
      lastFramePrompt: "人物停在画面中央的尾帧",
      negativePrompt: "避免水印、乱码和肢体畸变",
    }],
  };
}

function toLegacyStateRecord(record, status, result) {
  return {
    ...record,
    protocolVersion: 1,
    status,
    stage: status === "running" ? "executing" : status,
    leaseId: status === "running" ? `legacy-${record.id}` : null,
    workerId: status === "running" ? "legacy-owner" : null,
    resultAvailable: status === "completed",
    result: status === "completed" ? result : result,
    error: status === "failed" ? "Legacy failure" : null,
  };
}

test("Season Pack v1 state-directory GET is read-only for every status", async () => {
  for (const status of STATUSES) {
    const rootDir = makeTempRoot(`season-state-${status}`);
    try {
      const created = await createSeasonPackCodexJob({ script: `Season ${status}.`, episodeCount: 1 }, { rootDir });
      const queueRoot = path.join(rootDir, ".tmp-season-pack-codex");
      const pendingPath = path.join(queueRoot, "pending", `${created.id}.json`);
      const targetPath = path.join(queueRoot, status, `${created.id}.json`);
      const result = { seasonPlan: { projectTitle: status }, episodes: [{ episodeIndex: 1, input: { title: status } }] };
      const record = toLegacyStateRecord(JSON.parse(readFileSync(pendingPath, "utf8")), status, result);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (targetPath !== pendingPath) rmSync(pendingPath, { force: true });
      const before = snapshotFiles(rootDir);

      const observed = await getSeasonPackCodexJob(created.id, { rootDir });

      assert.equal(observed.protocolVersion, 1);
      assert.equal(observed.status, status);
      if (status === "completed") assert.equal(observed.result?.seasonPlan?.projectTitle, status);
      else {
        assert.equal(observed.result, null);
        assert.equal(observed.resultAvailable, false);
      }
      assert.deepEqual(snapshotFiles(rootDir), before, `Season ${status} GET must not modify queue bytes`);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("Render Pack v1 state-directory GET never completes parseable provisional output", async () => {
  for (const status of STATUSES) {
    const rootDir = makeTempRoot(`render-state-${status}`);
    try {
      const created = await createVideoPromptPackCodexJob({
        segments: [{
          episodeIndex: 1,
          title: `Render ${status}`,
          script: `Render ${status} source.`,
          renderInputScript: `Render ${status} input.`,
          duration: "12秒",
        }],
      }, { rootDir });
      const queueRoot = path.join(rootDir, ".tmp-video-prompt-pack-codex");
      const pendingPath = path.join(queueRoot, "pending", `${created.id}.json`);
      const targetPath = path.join(queueRoot, status, `${created.id}.json`);
      const result = {
        segments: [{
          episodeIndex: 1,
          outputPath: created.segments[0].outputPath,
          coverageOutputPath: created.segments[0].coverageOutputPath,
          result: legacyResult(`Render ${status}`),
          resultHash: `legacy-${status}`,
          coverageSidecar: null,
        }],
      };
      const record = toLegacyStateRecord(JSON.parse(readFileSync(pendingPath, "utf8")), status, result);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (targetPath !== pendingPath) rmSync(pendingPath, { force: true });
      if (status === "pending" || status === "running") {
        mkdirSync(path.dirname(created.segments[0].outputPath), { recursive: true });
        writeFileSync(created.segments[0].outputPath, JSON.stringify(legacyResult(`provisional-${status}`)), "utf8");
      }
      const before = snapshotFiles(rootDir);

      const observed = await getVideoPromptPackCodexJob(created.id, { rootDir });

      assert.equal(observed.protocolVersion, 1);
      assert.equal(observed.status, status);
      if (status === "completed") assert.equal(observed.result?.segments?.[0]?.result?.title, `Render ${status}`);
      else {
        assert.equal(observed.result, null);
        assert.equal(observed.resultAvailable, false);
      }
      assert.deepEqual(snapshotFiles(rootDir), before, `Render ${status} GET must not modify queue bytes`);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("Season and Render legacy jobs-layout GET remains byte-for-byte read-only", async () => {
  for (const queue of ["season", "render"]) {
    for (const status of STATUSES) {
      const rootDir = makeTempRoot(`${queue}-jobs-${status}`);
      try {
        const created = queue === "season"
          ? await createSeasonPackCodexJob({ script: `${queue} ${status}.`, episodeCount: 1 }, { rootDir })
          : await createVideoPromptPackCodexJob({
            segments: [{
              episodeIndex: 1,
              title: `${queue} ${status}`,
              script: `${queue} ${status} source.`,
              renderInputScript: `${queue} ${status} input.`,
              duration: "12秒",
            }],
          }, { rootDir });
        const namespace = queue === "season" ? ".tmp-season-pack-codex" : ".tmp-video-prompt-pack-codex";
        const pendingPath = path.join(rootDir, namespace, "pending", `${created.id}.json`);
        const legacyPath = path.join(rootDir, namespace, "jobs", `${created.id}.json`);
        const result = queue === "season"
          ? { seasonPlan: { projectTitle: status }, episodes: [] }
          : { segments: [] };
        const record = toLegacyStateRecord(JSON.parse(readFileSync(pendingPath, "utf8")), status, result);
        mkdirSync(path.dirname(legacyPath), { recursive: true });
        writeFileSync(legacyPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        rmSync(pendingPath, { force: true });
        const before = snapshotFiles(rootDir);

        const observed = queue === "season"
          ? await getSeasonPackCodexJob(created.id, { rootDir })
          : await getVideoPromptPackCodexJob(created.id, { rootDir });

        assert.equal(observed.status, status);
        assert.deepEqual(snapshotFiles(rootDir), before, `${queue} ${status} legacy GET must be read-only`);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  }
});
