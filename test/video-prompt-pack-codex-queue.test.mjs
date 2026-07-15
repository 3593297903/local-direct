import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  failVideoPromptPackCodexJob,
  finalizeVideoPromptPackCodexJobFiles,
  getVideoPromptPackCodexJob,
  recoverFinalizedVideoPromptPackCodexJobs,
  updateVideoPromptPackCodexJobStage,
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

function writeWorkerHeartbeat(rootDir, workerName, workerInstanceId, pid = 777) {
  const runtimeRoot = path.join(rootDir, ".tmp-codex-runtime");
  const workerRoot = path.join(runtimeRoot, "workers");
  mkdirSync(workerRoot, { recursive: true });
  const runtimeFingerprint = "runtime-fingerprint";
  const environment = {
    schemaVersion: 1,
    status: "healthy",
    checkedAt: new Date().toISOString(),
    codexVersion: "test",
    runtimeFingerprint,
    errors: [],
  };
  writeFileSync(path.join(runtimeRoot, "environment.json"), JSON.stringify(environment), "utf8");
  writeFileSync(path.join(workerRoot, `${workerName}.${workerInstanceId}.json`), JSON.stringify({
    schemaVersion: 1,
    workerName,
    workerInstanceId,
    pid,
    heartbeatAt: new Date().toISOString(),
    runtimeFingerprint,
    status: "healthy",
    environment,
  }), "utf8");
}

async function enterRenderPackFinalizing(claimed, rootDir) {
  await updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "executing",
    { rootDir },
  );
  return updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "finalizing",
    { rootDir },
  );
}

async function finalizeAndCompleteRenderPack(claimed, rootDir) {
  const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
  const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
    rootDir,
    codexExitCode: 0,
    stabilityDelayMs: 0,
  });
  return completeVideoPromptPackCodexJob(
    finalizing.id,
    finalizing.leaseId,
    finalizing.fencingToken,
    finalized.resultRef,
    { rootDir },
  );
}

test("protocol v2 render packs never complete from a parseable intermediate file", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 3,
        title: "Intermediate segment",
        script: "Intermediate source text for a render pack.",
        renderInputScript: "Render the requested segment without publishing an intermediate draft.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    assert.equal(job.protocolVersion, 2);
    assert.equal(job.stage, "pending");
    assert.equal(job.resultAvailable, false);

    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    assert.equal(claimed.protocolVersion, 2);
    assert.equal(claimed.stage, "claimed");
    assert.match(claimed.segments[0].outputPath, /staging/i);
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(
      claimed.segments[0].outputPath,
      JSON.stringify(sampleAnalysisResult("Intermediate segment"), null, 2),
      "utf8",
    );

    const observed = await getVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(observed.status, "running");
    assert.equal(observed.resultAvailable, false);
    assert.equal(observed.result, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("published Render Pack cannot be failed after completion transport outage", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Published render segment",
        script: "Published render output must survive a temporary complete API outage.",
        renderInputScript: "Render one complete segment result with all required fields.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: "render-instance-a" });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(
      claimed.segments[0].outputPath,
      JSON.stringify(sampleAnalysisResult("Published render segment"), null, 2),
      "utf8",
    );
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
    const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
      rootDir,
      codexExitCode: 0,
      stabilityDelayMs: 0,
    });

    const protectedJob = await failVideoPromptPackCodexJob(
      claimed.id,
      claimed.leaseId,
      claimed.fencingToken,
      "Complete API returned 500",
      "JOB_STORAGE_BUSY",
      { rootDir },
    );
    assert.equal(protectedJob.status, "running");
    assert.equal(protectedJob.stage, "finalizing");
    assert.equal(protectedJob.resultRef.resultHash, finalized.resultRef.resultHash);
    assert.equal(protectedJob.resultAvailable, false);

    assert.equal(await recoverFinalizedVideoPromptPackCodexJobs(rootDir, 1), 1);
    const recovered = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.resultAvailable, true);
    assert.equal(recovered.attempt, 1, "published recovery must not invoke Codex again");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("render pack finalization publishes exactly the requested segment identities", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createVideoPromptPackCodexJob({
      segments: [2, 4].map((episodeIndex) => ({
        episodeIndex,
        title: `Segment ${episodeIndex}`,
        script: `Segment ${episodeIndex} source text.`,
        renderInputScript: `Render segment ${episodeIndex} with complete structural fields.`,
        duration: "12 seconds",
      })),
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    for (const segment of claimed.segments) {
      mkdirSync(path.dirname(segment.outputPath), { recursive: true });
      writeFileSync(segment.outputPath, JSON.stringify(sampleAnalysisResult(segment.title), null, 2), "utf8");
    }

    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
    assert.equal(completed.status, "completed");
    assert.equal(completed.stage, "completed");
    assert.equal(completed.resultAvailable, true);
    assert.deepEqual(completed.result.segments.map((segment) => segment.episodeIndex), [2, 4]);
    assert.equal(completed.resultRef.protocolVersion, 2);
    assert.match(completed.resultRef.resultHash, /^[a-f0-9]{64}$/);

    const reloaded = await getVideoPromptPackCodexJob(job.id, { rootDir });
    assert.equal(reloaded.resultAvailable, true);
    assert.equal(reloaded.resultRef.resultHash, completed.resultRef.resultHash);
    assert.deepEqual(reloaded.result.segments.map((segment) => segment.episodeIndex), [2, 4]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("render pack finalization rejects a missing requested segment with a stable code", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [1, 2].map((episodeIndex) => ({
        episodeIndex,
        title: `Segment ${episodeIndex}`,
        script: `Segment ${episodeIndex} source text.`,
        renderInputScript: `Render segment ${episodeIndex} with complete structural fields.`,
        duration: "12 seconds",
      })),
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(
      claimed.segments[0].outputPath,
      JSON.stringify(sampleAnalysisResult(claimed.segments[0].title), null, 2),
      "utf8",
    );
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);

    await assert.rejects(
      finalizeVideoPromptPackCodexJobFiles(finalizing, { rootDir, codexExitCode: 0, stabilityDelayMs: 0 }),
      (error) => error?.code === "PACK_FINALIZATION_MISSING_SEGMENT",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("render pack finalization excludes coverage evidence outside allowed contract fields", async () => {
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
      contractHash: "sc_sidecar_path",
    };
    await createVideoPromptPackCodexJob({
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
    mkdirSync(path.dirname(claimed.segments[0].coverageOutputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(result, null, 2), "utf8");
    writeFileSync(claimed.segments[0].coverageOutputPath, JSON.stringify({
      schemaVersion: 1,
      segmentIndex: 1,
      contractHash: contract.contractHash,
      receipts: [{ slotId: "recognition", evidence: [{ path: "workflow.fullVideoPrompt", quote: "第1段" }] }],
    }), "utf8");
    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
    assert.equal(completed.result.segments[0].coverageSidecar, null);
    const manifestPath = path.join(
      rootDir,
      ".tmp-video-prompt-pack-codex",
      ...completed.resultRef.manifestRelativePath.split("/"),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.outputFiles.some((output) => output.kind === "coverage_sidecar"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

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

    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
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
    mkdirSync(path.dirname(claimed.segments[0].coverageOutputPath), { recursive: true });
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

    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
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
    mkdirSync(path.dirname(invalidClaimed.segments[0].coverageOutputPath), { recursive: true });
    writeFileSync(invalidClaimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("第2段")), "utf8");
    writeFileSync(invalidClaimed.segments[0].coverageOutputPath, "{not-json", "utf8");
    const invalidCompleted = await finalizeAndCompleteRenderPack(invalidClaimed, rootDir);
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
    mkdirSync(path.dirname(claimed.segments[0].coverageOutputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("第1段"), null, 2), "utf8");
    writeFileSync(claimed.segments[0].coverageOutputPath, "{ invalid sidecar", "utf8");
    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.segments[0].coverageSidecar, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claim sweep completes a published Render Pack finalization without another Codex attempt", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Recovery segment",
        script: "Recover a worker-finalized segment without running Codex again.",
        renderInputScript: "Render one complete segment result.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Recovery segment"), null, 2), "utf8");
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
    const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
      rootDir,
      codexExitCode: 0,
      stabilityDelayMs: 0,
    });
    const runningPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "running", `${claimed.id}.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8"));
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(runningPath, JSON.stringify({
      ...running,
      heartbeatAt: staleAt,
      updatedAt: staleAt,
      finalizingAt: staleAt,
    }, null, 2), "utf8");

    const next = await claimNextVideoPromptPackCodexJob({ rootDir, runningTimeoutMs: 1 });
    assert.equal(next, null);
    const recovered = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.resultAvailable, true);
    assert.equal(recovered.resultRef.resultHash, finalized.resultRef.resultHash);
    assert.equal(recovered.attempt, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claim sweep publishes a valid staging manifest and completes without another Codex attempt", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 2,
        title: "Staging recovery segment",
        script: "Resume atomic publication from a worker-owned manifest.",
        renderInputScript: "Render one complete segment result.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Staging recovery segment"), null, 2), "utf8");
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
    const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
      rootDir,
      codexExitCode: 0,
      stabilityDelayMs: 0,
    });
    const publishedDir = path.join(
      rootDir,
      ".tmp-video-prompt-pack-codex",
      ...finalized.resultRef.relativePath.split("/"),
    );
    renameSync(publishedDir, claimed.stagingDir);
    const runningPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "running", `${claimed.id}.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8"));
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(runningPath, JSON.stringify({
      ...running,
      resultRef: null,
      resultAvailable: false,
      heartbeatAt: staleAt,
      updatedAt: staleAt,
    }, null, 2), "utf8");

    const next = await claimNextVideoPromptPackCodexJob({ rootDir, runningTimeoutMs: 1 });
    assert.equal(next, null);
    const recovered = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.resultRef.resultHash, finalized.resultRef.resultHash);
    assert.equal(recovered.attempt, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("exact healthy Render Pack owner protects staging without a final manifest", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Healthy worker segment",
        script: "A healthy worker still owns this staging attempt.",
        renderInputScript: "Do not duplicate the active execution.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: "render-owner-instance" });
    writeWorkerHeartbeat(rootDir, "video-prompt-pack", "render-owner-instance");
    const runningPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "running", `${claimed.id}.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8"));
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(runningPath, JSON.stringify({ ...running, heartbeatAt: staleAt, updatedAt: staleAt }, null, 2), "utf8");

    const next = await claimNextVideoPromptPackCodexJob({ rootDir, runningTimeoutMs: 1 });
    assert.equal(next, null);
    const active = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
    assert.equal(active.status, "running");
    assert.equal(active.fencingToken, claimed.fencingToken);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("new Render worker with reused PID reclaims only the stale previous owner", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "PID reuse recovery",
        script: "The old worker crashed before producing a final manifest.",
        renderInputScript: "Render one complete result after the stale lease is recovered.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const first = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: "render-old-instance" });
    writeWorkerHeartbeat(rootDir, "video-prompt-pack", "render-new-instance", 888);
    const runningPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "running", `${first.id}.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8"));
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(runningPath, JSON.stringify({
      ...running,
      stage: "executing",
      heartbeatAt: staleAt,
      updatedAt: staleAt,
      waitingSlotAt: staleAt,
      executingAt: staleAt,
      finalizingAt: staleAt,
    }, null, 2), "utf8");

    const reclaimed = await claimNextVideoPromptPackCodexJob({
      rootDir,
      runningTimeoutMs: 1,
      workerId: "render-new-instance",
    });
    assert.equal(reclaimed.id, first.id);
    assert.equal(reclaimed.workerId, "render-new-instance");
    assert.equal(reclaimed.fencingToken, first.fencingToken + 1);
    assert.notEqual(reclaimed.stagingDir, first.stagingDir);
    assert.equal(reclaimed.waitingSlotAt, undefined);
    assert.equal(reclaimed.executingAt, undefined);
    assert.equal(reclaimed.finalizingAt, undefined);
    assert.equal(reclaimed.resultRef, null);

    await assert.rejects(
      () => failVideoPromptPackCodexJob(first.id, first.leaseId, first.fencingToken, "stale", "TEST", { rootDir }),
      (error) => error?.code === "FINALIZATION_STALE_FENCE",
    );
    await assert.rejects(
      () => completeVideoPromptPackCodexJob(first.id, first.leaseId, first.fencingToken, {
        protocolVersion: 2,
        resultHash: "a".repeat(64),
        relativePath: "results/stale/result",
        manifestRelativePath: "results/stale/result/final-manifest.v2.json",
      }, { rootDir }),
      (error) => error?.code === "FINALIZATION_STALE_FENCE",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("protocol v2 Render worker skips protocol v1 pending jobs", async () => {
  const rootDir = makeTempRoot();
  try {
    const legacy = await createVideoPromptPackCodexJob({
      idempotencyKey: "legacy-pending",
      segments: [{
        episodeIndex: 1,
        title: "Legacy pending",
        script: "Legacy pending input.",
        renderInputScript: "Legacy worker only.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const pendingPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending", `${legacy.id}.json`);
    const legacyRecord = JSON.parse(readFileSync(pendingPath, "utf8"));
    writeFileSync(pendingPath, JSON.stringify({
      ...legacyRecord,
      protocolVersion: 1,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    }, null, 2), "utf8");
    const current = await createVideoPromptPackCodexJob({
      idempotencyKey: "protocol-v2-pending",
      segments: [{
        episodeIndex: 2,
        title: "Protocol v2 pending",
        script: "Protocol v2 pending input.",
        renderInputScript: "Protocol v2 worker input.",
        duration: "12 seconds",
      }],
    }, { rootDir });

    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    assert.equal(claimed.id, current.id);
    assert.equal(claimed.protocolVersion, 2);
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).protocolVersion, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Render Pack never exposes intermediate output and complete replay is idempotent across 100 reads", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Race segment",
        script: "Intermediate writes must remain private.",
        renderInputScript: "Render a final immutable segment.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Intermediate race"), null, 2), "utf8");
    for (let index = 0; index < 100; index += 1) {
      const observed = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
      assert.equal(observed.status, "running");
      assert.equal(observed.resultAvailable, false);
      assert.equal(observed.result, null);
    }
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Final race"), null, 2), "utf8");
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
    const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
      rootDir,
      codexExitCode: 0,
      stabilityDelayMs: 0,
    });
    const completed = await completeVideoPromptPackCodexJob(
      claimed.id,
      claimed.leaseId,
      claimed.fencingToken,
      finalized.resultRef,
      { rootDir },
    );
    for (let index = 0; index < 100; index += 1) {
      const replay = await completeVideoPromptPackCodexJob(
        claimed.id,
        claimed.leaseId,
        claimed.fencingToken,
        finalized.resultRef,
        { rootDir },
      );
      assert.equal(replay.resultRef.resultHash, completed.resultRef.resultHash);
      assert.equal(replay.attempt, 1);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Render finalization rejects output changed after Codex close and before stable publication", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Rewrite segment",
        script: "The process writes and then rewrites a parseable result.",
        renderInputScript: "Publish only the stable final bytes.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("First parseable result"), null, 2), "utf8");
    const finalizing = await enterRenderPackFinalizing(claimed, rootDir);
    const mutation = setTimeout(() => {
      writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Rewritten final result"), null, 2), "utf8");
    }, 10);
    await assert.rejects(
      () => finalizeVideoPromptPackCodexJobFiles(finalizing, {
        rootDir,
        codexExitCode: 0,
        stabilityDelayMs: 75,
      }),
      /changed|stable|hash/i,
    );
    clearTimeout(mutation);
    const observed = await getVideoPromptPackCodexJob(claimed.id, { rootDir });
    assert.equal(observed.status, "running");
    assert.equal(observed.resultAvailable, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("completed protocol v2 Render Pack refuses a missing immutable manifest", async () => {
  const rootDir = makeTempRoot();
  try {
    await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Manifest guard segment",
        script: "A completed job must retain its immutable manifest.",
        renderInputScript: "Render one complete result.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult("Manifest guard segment"), null, 2), "utf8");
    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
    const manifestPath = path.join(
      rootDir,
      ".tmp-video-prompt-pack-codex",
      ...completed.resultRef.manifestRelativePath.split("/"),
    );
    rmSync(manifestPath, { force: true });
    await assert.rejects(
      () => getVideoPromptPackCodexJob(claimed.id, { rootDir }),
      (error) => error?.code === "FINALIZATION_OUTPUT_MISSING",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("legacy completed Render Pack jobs remain readable without protocol v2 publication", async () => {
  const rootDir = makeTempRoot();
  try {
    const created = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Legacy completed segment",
        script: "Legacy completed input.",
        renderInputScript: "Legacy result.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const pendingPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending", `${created.id}.json`);
    const completedDir = path.join(rootDir, ".tmp-video-prompt-pack-codex", "completed");
    const completedPath = path.join(completedDir, `${created.id}.json`);
    mkdirSync(completedDir, { recursive: true });
    const legacyResult = sampleAnalysisResult("Legacy completed segment");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    writeFileSync(completedPath, JSON.stringify({
      ...pending,
      protocolVersion: 1,
      stage: "completed",
      status: "completed",
      resultAvailable: true,
      resultRef: null,
      result: {
        segments: [{
          episodeIndex: 1,
          outputPath: "legacy-output.json",
          coverageOutputPath: "legacy-coverage.json",
          result: legacyResult,
          resultHash: "legacy-result-hash",
          coverageSidecar: null,
        }],
      },
      completedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    rmSync(pendingPath, { force: true });

    const observed = await getVideoPromptPackCodexJob(created.id, { rootDir });
    assert.equal(observed.protocolVersion, 1);
    assert.equal(observed.status, "completed");
    assert.equal(observed.resultAvailable, true);
    assert.equal(observed.result.segments[0].result.title, "Legacy completed segment");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Render Pack v2 creation pause rejects only new jobs while existing v2 work remains readable", async () => {
  const rootDir = makeTempRoot();
  const previous = process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
  try {
    delete process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
    const existing = await createVideoPromptPackCodexJob({
      idempotencyKey: "existing-during-create-pause",
      segments: [{
        episodeIndex: 1,
        title: "Existing render",
        script: "Existing protocol v2 Render Pack remains available.",
        renderInputScript: "Render the existing task without creating another task.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED = "0";

    await assert.rejects(
      () => createVideoPromptPackCodexJob({
        segments: [{
          episodeIndex: 2,
          title: "Paused render",
          script: "This new Render Pack must be paused.",
          renderInputScript: "Do not create this job while rollout is paused.",
          duration: "12 seconds",
        }],
      }, { rootDir }),
      (error) => error?.code === "FINALIZATION_V2_CREATE_PAUSED",
    );
    const observed = await getVideoPromptPackCodexJob(existing.id, { rootDir });
    assert.equal(observed.id, existing.id);
    assert.equal(observed.protocolVersion, 2);
    const claimed = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: "rollout-render-owner" });
    assert.equal(claimed.id, existing.id);
    mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
    writeFileSync(
      claimed.segments[0].outputPath,
      JSON.stringify(sampleAnalysisResult(claimed.segments[0].title), null, 2),
      "utf8",
    );
    const completed = await finalizeAndCompleteRenderPack(claimed, rootDir);
    assert.equal(completed.status, "completed");
    assert.equal(completed.resultAvailable, true);
    assert.equal((await getVideoPromptPackCodexJob(existing.id, { rootDir })).status, "completed");
  } finally {
    if (previous === undefined) delete process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED;
    else process.env.CODEX_FINALIZATION_V2_CREATE_ENABLED = previous;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Render Pack legacy GET is read-only and never silently migrates its job file", async () => {
  const rootDir = makeTempRoot();
  try {
    const created = await createVideoPromptPackCodexJob({
      segments: [{
        episodeIndex: 1,
        title: "Legacy read-only render",
        script: "Legacy Render Pack remains readable in place.",
        renderInputScript: "Read this completed legacy result without migration.",
        duration: "12 seconds",
      }],
    }, { rootDir });
    const pendingPath = path.join(rootDir, ".tmp-video-prompt-pack-codex", "pending", `${created.id}.json`);
    const legacyDir = path.join(rootDir, ".tmp-video-prompt-pack-codex", "jobs");
    const legacyPath = path.join(legacyDir, `${created.id}.json`);
    mkdirSync(legacyDir, { recursive: true });
    const legacy = {
      ...JSON.parse(readFileSync(pendingPath, "utf8")),
      protocolVersion: 1,
      stage: "completed",
      status: "completed",
      resultAvailable: true,
      result: { segments: [] },
    };
    const before = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(legacyPath, before, "utf8");
    rmSync(pendingPath, { force: true });

    const observed = await getVideoPromptPackCodexJob(created.id, { rootDir });
    assert.equal(observed.protocolVersion, 1);
    assert.equal(readFileSync(legacyPath, "utf8"), before);
    assert.equal(existsSync(path.join(rootDir, ".tmp-video-prompt-pack-codex", "completed", `${created.id}.json`)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
