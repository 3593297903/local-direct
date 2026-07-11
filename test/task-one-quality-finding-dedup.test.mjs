import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { evaluateBatchSegmentQuality } = require("../lib/batch-segment-quality-gate.ts");

function resultWithRepeatedNegativeClause() {
  const shot = {
    shotNumber: 1,
    timeRange: "0s-3s",
    scene: "县城办公室桌前",
    visual: "人物在冷光办公室桌前翻开资料，动作克制而清晰。",
    shotType: "近景",
    composition: "桌面资料位于前景，人物侧脸和窗框形成稳定层次。",
    cameraMovement: "缓慢推进",
    lighting: "冷白窗光和台灯形成低饱和明暗层次。",
    sound: "纸张轻响与远处脚步声保持真实空间感。",
    dialogue: "无",
    emotion: "克制紧张",
    transition: "自然切换",
    shotPurpose: "建立人物面对关键资料时的克制压力与线索关系。",
    firstFramePrompt: "县城办公室内，资料铺在桌面，人物侧脸进入冷光。",
    videoPrompt: "镜头从资料缓慢推进到人物侧脸，动作、光线和环境声连续可执行。",
    lastFramePrompt: "人物手指停在资料边缘，窗外冷光保留下一动作悬念。",
    negativePrompt: "不要伤口特写，不要低清画面，不要字幕水印。",
  };
  return {
    title: "第1段｜资料显影",
    duration: "12秒",
    contentType: "短剧 / 悬疑",
    style: "现实主义",
    optimizedScript: "办公室内，人物核对资料。",
    workflow: {
      fullVideoPrompt: "办公室冷光中，画面不展示伤口特写。".repeat(60),
      fullNegativePrompt: "不要伤口特写，不要低清画面。",
    },
    storyboard: Array.from({ length: 4 }, (_, index) => ({ ...shot, shotNumber: index + 1, visual: `${shot.visual} 镜头${index + 1}。` })),
  };
}

test("quality gate emits one unique safety finding with affected paths", () => {
  const gate = evaluateBatchSegmentQuality(resultWithRepeatedNegativeClause(), {
    segmentIndex: 1,
    minFullPromptLength: 900,
  });
  const findings = gate.findings.filter((finding) => finding.code === "sensitive_term" && finding.ruleId === "wound_closeup");
  assert.equal(findings.length, 1);
  assert.ok(findings[0].affectedPathCount >= 6);
  assert.equal(gate.complianceRisk, "high");
  assert.ok(gate.promptQualityScore > 0);
  assert.equal(gate.blockingFindings.some((finding) => finding.fingerprint === findings[0].fingerprint), false);
});

test("prompt quality score is independent from compliance risk count", () => {
  const gate = evaluateBatchSegmentQuality(resultWithRepeatedNegativeClause(), {
    segmentIndex: 1,
    minFullPromptLength: 900,
  });
  assert.equal(gate.score, gate.promptQualityScore);
  assert.notEqual(gate.complianceRisk, "none");
});

