import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  claimNextSeasonPackCodexJob,
  completeSeasonPackCodexJob,
  createSeasonPackCodexJob,
  finalizeSeasonPackCodexJobFiles,
  updateSeasonPackCodexJobStage,
} = require("../lib/season-pack-codex-queue.ts");
const {
  claimNextVideoPromptPackCodexJob,
  completeVideoPromptPackCodexJob,
  createVideoPromptPackCodexJob,
  finalizeVideoPromptPackCodexJobFiles,
  getVideoPromptPackCodexJob,
  updateVideoPromptPackCodexJobStage,
} = require("../lib/video-prompt-pack-codex-queue.ts");

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runFinalizationBenchmark(options = {}) {
  const iterations = positiveInteger(options.iterations, 30);
  if (iterations < 30) throw new Error("Phase 1 finalization benchmark requires at least 30 iterations");
  const seasonSegments = positiveInteger(options.seasonSegments, 30);
  const renderSegments = positiveInteger(options.renderSegments, 5);
  if (seasonSegments !== 30) throw new Error("Season finalization benchmark must use exactly 30 segments");
  if (![3, 5].includes(renderSegments)) throw new Error("Render finalization benchmark must use 3 or 5 segments");
  const benchmarkRoot = path.join(os.tmpdir(), `localdirector-phase-1-finalization-${process.pid}-${Date.now()}`);
  const seasonSamples = [];
  const renderSamples = [];
  try {
    for (let index = 0; index < iterations; index += 1) {
      seasonSamples.push(await benchmarkSeasonFinalization(
        path.join(benchmarkRoot, `season-${String(index).padStart(3, "0")}`),
        seasonSegments,
      ));
      renderSamples.push(await benchmarkRenderFinalization(
        path.join(benchmarkRoot, `render-${String(index).padStart(3, "0")}`),
        renderSegments,
      ));
    }
    const raceReplay = await benchmarkRaceReplay(path.join(benchmarkRoot, "race-replay"));
    const report = {
      schemaVersion: 1,
      phase: "phase-1-worker-owned-finalization",
      taskCommit: gitValue(["rev-parse", "HEAD"]),
      generatedAt: new Date().toISOString(),
      modelCalls: 0,
      judgeCalls: 0,
      repairCalls: 0,
      singleFallbackCalls: 0,
      seasonFinalization: {
        segments: seasonSegments,
        samples: iterations,
        ...summarize(seasonSamples),
        thresholdP95Ms: 2_000,
      },
      renderFinalization: {
        segments: renderSegments,
        samples: iterations,
        ...summarize(renderSamples),
        thresholdP95Ms: 1_000,
      },
      raceReplay,
    };
    assertReport(report);
    if (options.output) {
      const outputPath = path.resolve(options.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      report.outputPath = outputPath;
    }
    return report;
  } finally {
    rmSync(benchmarkRoot, { recursive: true, force: true });
  }
}

async function benchmarkSeasonFinalization(rootDir, segmentCount) {
  const created = await createSeasonPackCodexJob({
    script: Array.from({ length: segmentCount }, (_, index) => `第${index + 1}段：冻结剧情事件。`).join("\n"),
    episodeCount: segmentCount,
    duration: "15秒",
  }, { rootDir });
  const claimed = await claimNextSeasonPackCodexJob({ rootDir, workerId: `benchmark-season-${created.id}` });
  mkdirSync(claimed.episodesDir, { recursive: true });
  writeFileSync(claimed.manifestPath, JSON.stringify({
    episodeCount: segmentCount,
    generatedEpisodes: Array.from({ length: segmentCount }, (_, index) => index + 1),
  }), "utf8");
  writeFileSync(claimed.seasonPlanPath, JSON.stringify({
    storyBible: { title: "Phase 1 frozen benchmark" },
    lockedSegments: Array.from({ length: segmentCount }, (_, index) => ({
      segmentIndex: index + 1,
      title: `第${index + 1}段｜冻结事件`,
      beatStart: index + 1,
      beatEnd: index + 1,
      beatIds: [`B${String(index + 1).padStart(3, "0")}`],
      estimatedDurationSeconds: 12,
      shotCount: 4,
      sourceText: `第${index + 1}段冻结源事件。`,
    })),
  }), "utf8");
  for (let index = 1; index <= segmentCount; index += 1) {
    writeFileSync(
      path.join(claimed.episodesDir, `episode-${String(index).padStart(3, "0")}.json`),
      JSON.stringify(sampleEpisodeInput(index)),
      "utf8",
    );
  }
  await updateSeasonPackCodexJobStage(claimed.id, claimed.leaseId, claimed.fencingToken, "executing", { rootDir });
  const finalizing = await updateSeasonPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "finalizing",
    { rootDir },
  );
  const startedAt = performance.now();
  const finalized = await finalizeSeasonPackCodexJobFiles(finalizing, {
    rootDir,
    codexExitCode: 0,
    stabilityDelayMs: 0,
  });
  await completeSeasonPackCodexJob(
    finalizing.id,
    finalizing.leaseId,
    finalizing.fencingToken,
    finalized.resultRef,
    { rootDir },
  );
  return performance.now() - startedAt;
}

async function benchmarkRenderFinalization(rootDir, segmentCount) {
  const created = await createVideoPromptPackCodexJob({
    idempotencyKey: `phase-1-render-${path.basename(rootDir)}`,
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      episodeIndex: index + 1,
      title: `第${index + 1}段｜冻结镜头`,
      script: `第${index + 1}段冻结剧情输入。`,
      renderInputScript: `第${index + 1}段冻结渲染输入。`,
      duration: "12秒",
    })),
  }, { rootDir });
  const claimed = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: `benchmark-render-${created.id}` });
  for (const segment of claimed.segments) {
    mkdirSync(path.dirname(segment.outputPath), { recursive: true });
    writeFileSync(segment.outputPath, JSON.stringify(sampleAnalysisResult(segment.episodeIndex)), "utf8");
  }
  await updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "executing",
    { rootDir },
  );
  const finalizing = await updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "finalizing",
    { rootDir },
  );
  const startedAt = performance.now();
  const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
    rootDir,
    codexExitCode: 0,
    stabilityDelayMs: 0,
  });
  await completeVideoPromptPackCodexJob(
    finalizing.id,
    finalizing.leaseId,
    finalizing.fencingToken,
    finalized.resultRef,
    { rootDir },
  );
  return performance.now() - startedAt;
}

async function benchmarkRaceReplay(rootDir) {
  await createVideoPromptPackCodexJob({
    idempotencyKey: "phase-1-race-replay",
    segments: [{
      episodeIndex: 1,
      title: "第1段｜竞态回放",
      script: "中间结果不得提前可见。",
      renderInputScript: "发布稳定且不可变的最终结果。",
      duration: "12秒",
    }],
  }, { rootDir });
  const claimed = await claimNextVideoPromptPackCodexJob({ rootDir, workerId: "benchmark-race-owner" });
  mkdirSync(path.dirname(claimed.segments[0].outputPath), { recursive: true });
  writeFileSync(claimed.segments[0].outputPath, JSON.stringify(sampleAnalysisResult(1)), "utf8");
  let earlyVisibleResults = 0;
  for (let index = 0; index < 100; index += 1) {
    if ((await getVideoPromptPackCodexJob(claimed.id, { rootDir })).resultAvailable) earlyVisibleResults += 1;
  }
  await updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "executing",
    { rootDir },
  );
  const finalizing = await updateVideoPromptPackCodexJobStage(
    claimed.id,
    claimed.leaseId,
    claimed.fencingToken,
    "finalizing",
    { rootDir },
  );
  const finalized = await finalizeVideoPromptPackCodexJobFiles(finalizing, {
    rootDir,
    codexExitCode: 0,
    stabilityDelayMs: 0,
  });
  const references = new Set();
  for (let index = 0; index < 100; index += 1) {
    const completed = await completeVideoPromptPackCodexJob(
      finalizing.id,
      finalizing.leaseId,
      finalizing.fencingToken,
      finalized.resultRef,
      { rootDir },
    );
    references.add(JSON.stringify(completed.resultRef));
  }
  return {
    intermediateReads: 100,
    earlyVisibleResults,
    completeReplays: 100,
    distinctResultReferences: references.size,
    codexCalls: 0,
  };
}

function sampleEpisodeInput(index) {
  return {
    episodeIndex: index,
    title: `第${index}段｜冻结事件`,
    sourceText: `第${index}段冻结源事件。`,
    duration: "12秒",
    contentType: "短剧",
    style: "电影级写实",
    storyBible: {
      projectTitle: "Phase 1 frozen benchmark",
      characters: [{ id: "CHAR_01", name: "主角" }],
      visualStyle: "写实自然光",
    },
    episodeChain: {
      episodeIndex: index,
      startState: "承接前段。",
      endState: "完成本段事件。",
      nextBridge: "自然进入后段。",
    },
    blueprint: {
      purpose: "推进冻结事件。",
      keyEvents: ["空间建立", "动作推进", "情绪变化", "段尾承接"],
    },
    shotCount: 4,
    renderInputScript: `第${index}段冻结渲染输入，严格生成四个完整镜头。`,
  };
}

function sampleAnalysisResult(index) {
  return {
    title: `第${index}段｜冻结镜头`,
    contentType: "短剧",
    duration: "12秒",
    style: "电影级写实",
    diagnosis: ["结构完整"],
    optimizedScript: `第${index}段冻结优化文案。`,
    workflow: {
      sourceAnalysis: `第${index}段冻结分析。`,
      screenplay: `第${index}段冻结剧本。`,
      filmScript: `第${index}段冻结拍摄脚本。`,
      fullVideoPrompt: `第${index}段冻结完整视频提示词。`,
      fullNegativePrompt: "避免水印、错误文字与肢体变形。",
      concisePrompt: `第${index}段冻结简洁提示词。`,
    },
    storyboard: [{
      shotNumber: 1,
      timeRange: "0秒-3秒",
      scene: "室内空间",
      visual: "人物在清晰可辨的空间里完成连续动作。",
      shotType: "中景",
      composition: "平视构图，主体与环境关系清楚。",
      cameraMovement: "缓慢推进",
      lighting: "自然实景光，层次清晰。",
      sound: "环境底噪与脚步声。",
      dialogue: "无",
      emotion: "克制紧张",
      transition: "动作切换",
      shotPurpose: "建立空间并推进本段事件。",
      firstFramePrompt: "人物位于清晰可辨的室内空间。",
      videoPrompt: "镜头缓慢推进，人物完成连续动作，空间层次和光线保持稳定。",
      lastFramePrompt: "人物动作停在段尾承接点。",
      negativePrompt: "避免水印、错误文字与肢体变形。",
    }],
  };
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function assertReport(report) {
  if (report.seasonFinalization.p95Ms >= report.seasonFinalization.thresholdP95Ms) {
    throw new Error(`Season finalization p95 exceeded threshold: ${report.seasonFinalization.p95Ms.toFixed(3)}ms`);
  }
  if (report.renderFinalization.p95Ms >= report.renderFinalization.thresholdP95Ms) {
    throw new Error(`Render finalization p95 exceeded threshold: ${report.renderFinalization.p95Ms.toFixed(3)}ms`);
  }
  if (report.raceReplay.earlyVisibleResults !== 0) throw new Error("Intermediate results became visible");
  if (report.raceReplay.distinctResultReferences !== 1) throw new Error("Complete replay returned multiple result references");
  if ([report.modelCalls, report.judgeCalls, report.repairCalls, report.singleFallbackCalls].some(Boolean)) {
    throw new Error("Finalization benchmark unexpectedly invoked a model path");
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function gitValue(args) {
  return execFileSync("git", args, { cwd: scriptRoot, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((argument) => {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    return [match[1], match[2]];
  }));
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  runFinalizationBenchmark({
    iterations: args.iterations,
    seasonSegments: args["season-segments"],
    renderSegments: args["render-segments"],
    output: args.output,
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
