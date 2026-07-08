import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});

const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createSegmentQualityReport,
  detectSegmentSafetyRisk,
  summarizeSegmentQualityReports,
  updateSegmentQualityReportStatus,
} = require("../lib/batch-segment-quality-report.ts");

function makeResult(overrides = {}) {
  const storyboard = overrides.storyboard || [
    {
      timeRange: "0s-3s",
      scene: "雨夜街口",
      visual: "雨水沿着旧墙滑落，主角停在路灯下观察巷口。",
      shotType: "中景",
      composition: "人物在左侧三分线，右侧留出湿冷巷口。",
      cameraMovement: "缓慢推进",
      lighting: "冷蓝路灯与暖黄窗光形成对比",
      sound: "雨声、远处车声",
      dialogue: "无",
      emotion: "紧张",
      transition: "雨声延续",
      shotPurpose: "建立空间和悬疑氛围",
      firstFramePrompt: "雨夜街口，人物停在路灯下",
      videoPrompt: "镜头缓慢推进，雨水和远处车灯强化空间压迫感。",
      lastFramePrompt: "人物抬头看向巷口深处",
      negativePrompt: "不要字幕，不要畸形手，不要低清晰度",
    },
    {
      timeRange: "3s-7s",
      scene: "巷口",
      visual: "角色发现地面水痕旁有一张被雨水打湿的照片。",
      shotType: "近景",
      composition: "照片位于画面下方，人物手部进入画面。",
      cameraMovement: "下压推近",
      lighting: "路灯反光落在水面",
      sound: "纸张被拾起的声音",
      dialogue: "无",
      emotion: "疑惑",
      transition: "动作匹配",
      shotPurpose: "引出关键物件",
      firstFramePrompt: "水痕旁的旧照片",
      videoPrompt: "手部进入画面拾起照片，雨滴打在纸面上。",
      lastFramePrompt: "照片背面露出地址",
      negativePrompt: "不要乱码文字，不要血腥特写",
    },
    {
      timeRange: "7s-11s",
      scene: "巷内",
      visual: "人物沿着地址提示走入更深的巷子，背影被雨幕吞没。",
      shotType: "远景",
      composition: "巷道形成纵深线，人物在中央远处。",
      cameraMovement: "稳定跟拍",
      lighting: "冷光逐渐变暗",
      sound: "脚步声和雨声",
      dialogue: "无",
      emotion: "不安",
      transition: "黑场转场",
      shotPurpose: "把线索推进到下一段",
      firstFramePrompt: "人物站在巷口",
      videoPrompt: "跟拍人物进入巷子，雨声持续增强。",
      lastFramePrompt: "人物背影消失在黑暗里",
      negativePrompt: "不要突脸，不要怪物，不要廉价特效",
    },
  ];
  return {
    title: overrides.title || "第1段｜雨夜线索",
    duration: overrides.duration || "11秒",
    style: overrides.style || "现实悬疑短剧，冷色调，电影摄影质感",
    contentType: overrides.contentType || "短剧 / 悬疑",
    optimizedScript: overrides.optimizedScript || "角色在雨夜发现照片背面的地址，决定沿线索继续寻找。",
    workflow: {
      fullVideoPrompt: overrides.fullVideoPrompt || "雨夜街口，角色发现照片背面的地址，沿巷子继续寻找。".repeat(40),
      fullNegativePrompt: overrides.fullNegativePrompt || "不要字幕，不要低清晰度，不要畸形手，不要乱码文字",
    },
    storyboard,
    ...overrides,
  };
}

test("quality report gives strong complete prompts a high score and stable hashes", () => {
  const report = createSegmentQualityReport({
    batchId: "season-pack-job-1",
    projectId: "project-1",
    segmentIndex: 1,
    title: "第1段｜雨夜线索",
    result: makeResult(),
    sourceText: "雨夜里，角色在巷口发现一张旧照片。",
    status: "cached",
    scheduleProfile: "FAST",
    packIndex: 1,
    packSize: 4,
    repairCount: 0,
    repairReasons: [],
    renderStartedAt: 1000,
    renderCompletedAt: 61000,
    contractHash: "sc_abc",
  });

  assert.equal(report.segmentIndex, 1);
  assert.equal(report.durationMs, 60000);
  assert.equal(report.status, "cached");
  assert.ok(report.qualityScore >= 90);
  assert.equal(report.safetyRisk, "low");
  assert.match(report.renderHash, /^qr_[a-z0-9]+$/);
  assert.match(report.sourceHash, /^qr_[a-z0-9]+$/);
});

test("quality report flags thin prompts, episode terminology, and repeated repair reasons", () => {
  const report = createSegmentQualityReport({
    batchId: "season-pack-job-2",
    segmentIndex: 2,
    title: "第2段｜薄弱结果",
    result: makeResult({
      title: "第2集｜薄弱结果",
      fullVideoPrompt: "第2集：角色继续调查。同上。",
      storyboard: [
        {
          timeRange: "0s-3s",
          scene: "房间",
          visual: "角色看照片。",
          shotType: "近景",
          composition: "居中",
          cameraMovement: "固定",
          lighting: "冷光",
          sound: "无",
          dialogue: "无",
          emotion: "紧张",
          transition: "切",
          shotPurpose: "推进",
          firstFramePrompt: "照片",
          videoPrompt: "角色看照片",
          lastFramePrompt: "照片",
          negativePrompt: "不要低清晰度",
        },
      ],
    }),
    sourceText: "角色继续调查照片线索。",
    status: "repaired",
    scheduleProfile: "STRICT",
    packIndex: 1,
    packSize: 2,
    repairCount: 2,
    repairReasons: ["提示词过短", "仍包含剧集术语"],
  });

  assert.ok(report.qualityScore < 70);
  assert.match(report.qualityFindings.join("\n"), /提示词过短/);
  assert.match(report.qualityFindings.join("\n"), /剧集术语/);
  assert.match(report.qualityFindings.join("\n"), /修复 2 次/);
});

test("safety risk detection classifies Seedance-sensitive wording without blocking generation", () => {
  const risk = detectSegmentSafetyRisk("公安局门口出现警徽和国徽，地面有血泊，镜头特写尸体。");

  assert.equal(risk.risk, "high");
  assert.ok(risk.findings.some((finding) => finding.includes("国徽")));
  assert.ok(risk.findings.some((finding) => finding.includes("血泊")));
});

test("quality report summary exposes average score, review count, highest risk, and slowest segment", () => {
  const good = createSegmentQualityReport({
    batchId: "batch",
    segmentIndex: 1,
    title: "第1段",
    result: makeResult(),
    sourceText: "第一段原文",
    status: "saved",
    scheduleProfile: "FAST",
    packIndex: 1,
    packSize: 4,
    renderStartedAt: 0,
    renderCompletedAt: 30000,
  });
  const risky = createSegmentQualityReport({
    batchId: "batch",
    segmentIndex: 2,
    title: "第2段",
    result: makeResult({ fullVideoPrompt: "公安局门口出现警徽和国徽，地面有血泊。".repeat(30) }),
    sourceText: "第二段原文",
    status: "cached",
    scheduleProfile: "FAST",
    packIndex: 1,
    packSize: 4,
    repairCount: 1,
    repairReasons: ["合规风险"],
    renderStartedAt: 0,
    renderCompletedAt: 120000,
  });
  const failed = updateSegmentQualityReportStatus(risky, "failed", {
    repairReasons: ["合规风险", "保存失败"],
    durationMs: 150000,
  });

  const summary = summarizeSegmentQualityReports([good, failed]);

  assert.equal(summary.totalReports, 2);
  assert.ok(summary.averageQualityScore > 0);
  assert.equal(summary.suggestedReviewCount, 1);
  assert.equal(summary.highestSafetyRisk, "high");
  assert.equal(summary.slowestSegmentIndex, 2);
  assert.equal(summary.slowestDurationMs, 150000);
});
