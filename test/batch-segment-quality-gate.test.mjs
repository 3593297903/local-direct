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
  applyDeterministicQualityPatch,
  evaluateBatchSegmentQuality,
  shouldRepairWithCodex,
} = require("../lib/batch-segment-quality-gate.ts");

function baseResult(overrides = {}) {
  return {
    title: "第1段｜案情显影",
    contentType: "短剧 / 刑侦悬疑",
    duration: "12秒",
    style: "冷峻现实主义刑侦短剧",
    diagnosis: [],
    optimizedScript: "调查室内，聊天记录证据被投到屏幕上，角色关系逐渐清晰。",
    recommendedItems: [],
    editingNotes: [],
    workflow: {
      sourceAnalysis: "调查室内，聊天记录证据被投到屏幕上。",
      screenplay: "调查室内，聊天记录证据被投到屏幕上。",
      filmScript: "调查室内，聊天记录证据被投到屏幕上。",
      concisePrompt: "调查室，聊天记录，冷光。",
      fullVideoPrompt: "调查室内，聊天记录证据被投到屏幕上，人物在冷光中确认线索。",
      fullNegativePrompt: "不要低清画面。",
    },
    storyboard: [
      {
        shotNumber: 1,
        timeRange: "0s-3s",
        scene: "调查室",
        visual: "屏幕亮起，聊天记录证据停在最后一页，调查员站在桌边。",
        shotType: "近景",
        composition: "屏幕占据画面右侧，人物侧影留在左侧。",
        cameraMovement: "缓慢推进",
        lighting: "冷白屏幕光照亮人物侧脸。",
        sound: "键盘轻响。",
        dialogue: "",
        emotion: "紧张",
        transition: "切到屏幕",
        shotPurpose: "让聊天记录成为本段关键线索。",
        firstFramePrompt: "调查室屏幕亮起。",
        videoPrompt: "镜头推进到屏幕上的聊天记录，人物在冷光中停住。",
        lastFramePrompt: "屏幕上的最后一句话停住。",
        negativePrompt: "不要出现 undefined/null，不要字幕水印。",
      },
    ],
    ...overrides,
  };
}

test("patches short fields and negative prompt pollution without requiring Codex repair", () => {
  const raw = baseResult();
  const firstGate = evaluateBatchSegmentQuality(raw, { minFullPromptLength: 20 });

  assert.equal(firstGate.findings.some((finding) => finding.code === "field_below_target"), true);

  const patched = applyDeterministicQualityPatch(raw, firstGate.findings);
  const finalGate = evaluateBatchSegmentQuality(patched, {
    fullPromptText: patched.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });

  assert.equal(shouldRepairWithCodex(finalGate), false);
  assert.equal(patched.storyboard[0].dialogue, "无");
  assert.doesNotMatch(patched.storyboard[0].negativePrompt, /\bundefined\b|\bnull\b/i);
  assert.ok(patched.storyboard[0].videoPrompt.replace(/\s+/g, "").length >= 40);
  assert.ok(patched.storyboard[0].firstFramePrompt.replace(/\s+/g, "").length >= 24);
});

test("keeps genuinely broken storyboard results as blocking", () => {
  const broken = baseResult({ storyboard: [] });
  const gate = evaluateBatchSegmentQuality(broken, { minFullPromptLength: 900 });

  assert.equal(shouldRepairWithCodex(gate), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "missing_storyboard"), true);
});

test("removes internal English identifiers deterministically before final cache", () => {
  const raw = baseResult({
    contentType: "single-segment AnalysisResult",
    workflow: {
      ...baseResult().workflow,
      fullVideoPrompt: "调查室里打开 chat-log 和 qq_records，forensic_room 的资料被投到墙上。",
    },
  });

  const patched = applyDeterministicQualityPatch(raw, evaluateBatchSegmentQuality(raw).findings);
  const serialized = JSON.stringify(patched);

  assert.doesNotMatch(serialized, /single-segment|AnalysisResult|chat-log|qq_records|forensic_room/i);
});

test("rewrites negative prompt placeholder warnings without requiring Codex repair", () => {
  const raw = baseResult({
    workflow: {
      ...baseResult().workflow,
      fullVideoPrompt: "调查室冷光中，屏幕展示聊天记录。负面提示词：避免同上、如上、略等占位表达。",
      fullNegativePrompt: "避免同上、如上、略等占位表达，避免低清画面。",
    },
    storyboard: [
      {
        ...baseResult().storyboard[0],
        negativePrompt: "避免同上如上略等占位表达，避免低清画面。",
      },
    ],
  });

  const firstGate = evaluateBatchSegmentQuality(raw, {
    fullPromptText: raw.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });
  assert.equal(firstGate.findings.some((finding) => finding.code === "placeholder_text"), true);

  const patched = applyDeterministicQualityPatch(raw, firstGate.findings);
  const finalGate = evaluateBatchSegmentQuality(patched, {
    fullPromptText: patched.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });

  assert.equal(shouldRepairWithCodex(finalGate), false);
  assert.doesNotMatch(patched.workflow.fullNegativePrompt, /同上|如上|见上文|(?:^|[，。；、\s])略(?:[，。；、\s]|$)/);
  assert.doesNotMatch(patched.storyboard[0].negativePrompt, /同上|如上|见上文|(?:^|[，。；、\s])略(?:[，。；、\s]|$)/);
  assert.doesNotMatch(patched.workflow.fullVideoPrompt, /同上|如上|见上文|(?:^|[，。；、\s])略(?:[，。；、\s]|$)/);
});

test("keeps executable placeholder text as blocking", () => {
  const raw = baseResult({
    storyboard: [
      {
        ...baseResult().storyboard[0],
        videoPrompt: "同上，继续上一镜头。",
      },
    ],
  });

  const gate = evaluateBatchSegmentQuality(raw, { minFullPromptLength: 20 });

  assert.equal(shouldRepairWithCodex(gate), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "placeholder_text"), true);
});
