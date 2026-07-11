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
  claimNextVideoPromptPackCodexJob,
  completeVideoPromptPackCodexJob,
  createVideoPromptPackCodexJob,
  getVideoPromptPackCodexJob,
} = require("../lib/video-prompt-pack-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-video-prompt-pack-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sampleAnalysisResult(title = "Segment result") {
  return {
    title,
    contentType: "short drama",
    duration: "15 seconds",
    style: "cinematic realism",
    diagnosis: ["complete prompt"],
    optimizedScript: `${title} optimized script`,
    workflow: {
      sourceAnalysis: `${title} source analysis`,
      screenplay: `${title} screenplay`,
      filmScript: `${title} film script`,
      fullVideoPrompt: `${title} full video prompt`,
      fullNegativePrompt: "no watermark, no bad anatomy",
      concisePrompt: `${title} concise prompt`,
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0.0s-3.0s",
        scene: "room",
        visual: `${title} starts with a clear cinematic room action.`,
        shotType: "medium shot",
        composition: "eye-level frame with the subject centered and background readable",
        cameraMovement: "slow push in",
        lighting: "soft practical light with low contrast shadows",
        sound: "quiet room tone and light footsteps",
        dialogue: "none",
        emotion: "tense",
        transition: "cut",
        shotPurpose: "establish the segment conflict and visual tone",
        firstFramePrompt: `${title} first frame`,
        videoPrompt: `${title} video prompt`,
        lastFramePrompt: `${title} last frame`,
        negativePrompt: "no text artifacts, no watermark",
      },
    ],
  };
}

test("creates, claims, and completes a video prompt render pack job with independent segment JSON files", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        segments: [
          {
            episodeIndex: 1,
            title: "Segment 1",
            script: "Segment one source text.",
            renderInputScript: "Render segment one with full single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
            segmentContract: {
              segmentIndex: 1,
              title: "Segment 1",
              sourceText: "Segment one source text.",
              durationSeconds: 15,
              shotCount: 4,
              requiredEvents: ["source event one"],
              forbiddenFutureEvents: ["future event two"],
              characters: [],
              locations: [],
              props: [{ name: "qq_records" }],
              requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-3s", beat: "source event one", visualFocus: "room" }],
              safetyPolicy: { avoidTerms: [], rewriteHints: {} },
              contractHash: "sc_test",
            },
          },
          {
            episodeIndex: 2,
            title: "Segment 2",
            script: "Segment two source text.",
            renderInputScript: "Render segment two with full single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
          },
          {
            episodeIndex: 3,
            title: "Segment 3",
            script: "Segment three source text.",
            renderInputScript: "Render segment three with full single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
          },
          {
            episodeIndex: 4,
            title: "Segment 4",
            script: "Segment four source text.",
            renderInputScript: "Render segment four with full single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
          },
          {
            episodeIndex: 5,
            title: "Segment 5",
            script: "Segment five source text.",
            renderInputScript: "Render segment five with full single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
          },
        ],
      },
      { rootDir },
    );

    assert.equal(job.status, "pending");
    assert.match(job.id, /^video-prompt-pack-job-/);
    assert.equal(job.segments.length, 5);
    assert.match(job.prompt, /Render Pack/);
    assert.match(job.prompt, /段落契约/);
    assert.match(job.prompt, /source event one/);
    assert.match(job.prompt, /future event two/);
    assert.match(job.prompt, /episode-001\.json/);
    assert.match(job.prompt, /episode-005\.json/);
    assert.match(job.prompt, /Do not use 同上/);
    assert.doesNotMatch(job.prompt, /single-segment AnalysisResult/);
    assert.doesNotMatch(job.prompt, /single-segment/i);
    assert.doesNotMatch(job.prompt, /SegmentContract/);
    assert.doesNotMatch(job.prompt, /chat-log/);
    assert.doesNotMatch(job.prompt, /qq_records/);

    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    assert.ok(claimed);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");

    for (const segment of claimed.segments) {
      mkdirSync(path.dirname(segment.outputPath), { recursive: true });
      writeFileSync(segment.outputPath, JSON.stringify(sampleAnalysisResult(segment.title), null, 2), "utf8");
    }

    const completed = await completeVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.segments.length, 5);
    assert.deepEqual(completed.result.segments.map((segment) => segment.episodeIndex), [1, 2, 3, 4, 5]);
    assert.equal(completed.result.segments[1].result.title, "Segment 2");

    const reloaded = await getVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.result.segments[4].result.workflow.fullVideoPrompt, "Segment 5 full video prompt");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("video prompt render pack jobs claim the oldest pending task by default", async () => {
  const rootDir = makeTempRoot();
  try {
    const first = await createVideoPromptPackCodexJob(
      {
        segments: [
          {
            episodeIndex: 1,
            title: "First pack",
            script: "First pack source text.",
            renderInputScript: "Render first pack.",
            duration: "15 seconds",
          },
        ],
      },
      { rootDir },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createVideoPromptPackCodexJob(
      {
        segments: [
          {
            episodeIndex: 2,
            title: "Second pack",
            script: "Second pack source text.",
            renderInputScript: "Render second pack.",
            duration: "15 seconds",
          },
        ],
      },
      { rootDir },
    );

    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    assert.ok(claimed);
    assert.equal(claimed.id, first.id);
    assert.notEqual(claimed.id, second.id);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("strict UTF-8 render pack mode is persisted and hardens the Codex prompt", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob(
      {
        mode: "strictUtf8",
        segments: [
          {
            episodeIndex: 1,
            title: "Strict UTF-8 Segment",
            script: "这是一段中文源文案，用来验证严格 UTF-8 输出。",
            renderInputScript: "Render this segment with full single-segment quality and preserve Chinese text.",
            duration: "15 seconds",
            shotCount: 4,
          },
        ],
      },
      { rootDir },
    );

    assert.equal(job.mode, "strictUtf8");
    assert.match(job.prompt, /STRICT_UTF8_RECOVERY_MODE/);
    assert.match(job.prompt, /fs\.writeFileSync/);
    assert.match(job.prompt, /Do not use PowerShell Set-Content/);
    assert.match(job.prompt, /excessive question marks/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("video prompt render pack jobs default to strict UTF-8 mode", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob(
      {
        segments: [
          {
            episodeIndex: 1,
            title: "Default strict segment",
            script: "中文源文案需要稳定 UTF-8 输出。",
            renderInputScript: "Render this segment with complete single-segment quality.",
            duration: "15 seconds",
            shotCount: 4,
          },
        ],
      },
      { rootDir },
    );

    assert.equal(job.mode, "strictUtf8");
    assert.match(job.prompt, /STRICT_UTF8_RECOVERY_MODE/);
    assert.match(job.prompt, /1400 meaningful Chinese characters/);
    assert.match(job.prompt, /3-shot segments should usually have at least 1100/);
    assert.match(job.prompt, /Do not make thin shots/);
    assert.match(job.prompt, /videoPrompt must describe the full moving image/);
    assert.match(job.prompt, /natural Chinese labels/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("coverage sidecars stay separate and never make a valid main result fail", async () => {
  const rootDir = makeTempRoot();
  try {
    const contract = {
      contractSchemaVersion: 2,
      coveragePolicyVersion: "test",
      sourceHash: "src_test",
      segmentIndex: 1,
      title: "第1段",
      sourceText: "大妈认出照片中的邻居。",
      durationSeconds: 12,
      shotCount: 1,
      requiredEvents: ["大妈认出邻居"],
      requiredEventSlots: [{
        id: "recognition",
        label: "大妈认出邻居",
        importance: "blocking",
        anchorGroups: [["大妈"]],
        conceptGroups: [["认出"]],
        contradictionGroups: [],
        evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["dialogue"], requireExecutableShot: true }],
        repairTargets: [{ shotNumber: 1, field: "dialogue" }],
      }],
      forbiddenFutureEvents: [],
      characterLocks: [],
      characters: [],
      locations: [],
      props: [],
      requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-12s", beat: "辨认", visualFocus: "照片" }],
      safetyPolicy: { avoidTerms: [], rewriteHints: {} },
      contractHash: "sc_sidecar",
    };
    const job = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "第1段",
        script: contract.sourceText,
        renderInputScript: "生成完整提示词",
        duration: "12秒",
        shotCount: 1,
        segmentContract: contract,
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    const result = sampleAnalysisResult("第1段");
    result.storyboard[0].dialogue = "大妈：这是隔壁老周。";
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(result, null, 2), "utf8");
    writeFileSync(claimed.segments[0].coverageOutputPath, JSON.stringify({
      schemaVersion: 1,
      segmentIndex: 1,
      contractHash: contract.contractHash,
      receipts: [{ slotId: "recognition", evidence: [{ path: "storyboard[0].dialogue", quote: "这是隔壁老周" }] }],
    }), "utf8");

    assert.match(claimed.prompt, /Do not write resultHash in the model sidecar/);
    assert.doesNotMatch(claimed.prompt, /__LOCAL_DIRECTOR_RESULT_HASH__/);
    assert.match(claimed.prompt, /slotId=recognition/);
    assert.match(claimed.prompt, /storyboard\[\*\]\.dialogue/);

    const completed = await completeVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(completed.result.segments[0].result.coverage, undefined);
    assert.equal(completed.result.segments[0].coverageSidecar.receipts[0].slotId, "recognition");
    assert.match(completed.result.segments[0].coverageSidecar.resultHash, /^sr_[a-z0-9]+$/);

    const invalidJob = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 2,
        title: "第2段",
        script: "这是用于验证无效 sidecar 不影响主结果的中文测试原文。",
        renderInputScript: "生成完整提示词",
        duration: "12秒",
        shotCount: 1,
        segmentContract: { ...contract, segmentIndex: 2, contractHash: "sc_invalid" },
      }],
    }, { rootDir });
    const invalidClaimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(invalidClaimed.segments[0].outputPath), { recursive: true });
    writeFileSync(invalidClaimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("第2段")), "utf8");
    writeFileSync(invalidClaimed.segments[0].coverageOutputPath, "{not-json", "utf8");
    const invalidCompleted = await completeVideoPromptPackCodexJob(invalidJob.id, { rootDir });
    assert.equal(invalidCompleted.result.segments[0].coverageSidecar, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a batch snapshot can disable coverage sidecars without changing the main result", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob({
      coverageSidecarEnabled: false,
      segments: [{
        episodeIndex: 1,
        title: "第1段",
        script: "人物走入办公室并放下资料。",
        renderInputScript: "生成完整中文视频提示词。",
        duration: "12秒",
        shotCount: 1,
      }],
    }, { rootDir });
    assert.equal(job.coverageSidecarEnabled, false);
    assert.doesNotMatch(job.prompt, /Optional internal coverage sidecar path/);
    assert.doesNotMatch(job.prompt, /you may write the optional coverage sidecar/);

    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("第1段"), null, 2), "utf8");
    writeFileSync(claimed.segments[0].coverageOutputPath, "{ invalid sidecar", "utf8");
    const completed = await completeVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.segments[0].coverageSidecar, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
