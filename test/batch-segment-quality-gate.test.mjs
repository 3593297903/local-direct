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
  applyDeterministicQualityPatchWithDiff,
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

test("abstracts corpse wording inside negative prompts without requiring Codex repair", () => {
  const raw = baseResult({
    workflow: {
      ...baseResult().workflow,
      fullNegativePrompt: "\u907f\u514d\u5c38\u4f53\u7ec6\u8282\uff0c\u907f\u514d\u4f4e\u6e05\u753b\u9762\u3002",
      fullVideoPrompt: "\u8c03\u67e5\u5ba4\u5185\u51b7\u5149\u7a33\u5b9a\uff0c\u4eba\u7269\u9762\u5bf9\u8bc1\u636e\u8868\u60c5\u514b\u5236\u3002",
    },
    storyboard: [
      {
        ...baseResult().storyboard[0],
        negativePrompt: "\u4e0d\u8981\u5c38\u4f53\u6b63\u8138\uff0c\u907f\u514d\u4f4e\u6e05\u753b\u9762\u3002",
      },
    ],
  });

  const firstGate = evaluateBatchSegmentQuality(raw, {
    fullPromptText: raw.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });
  const patched = applyDeterministicQualityPatch(raw, firstGate.findings);
  const finalGate = evaluateBatchSegmentQuality(patched, {
    fullPromptText: patched.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });

  assert.equal(shouldRepairWithCodex(finalGate), false);
  assert.doesNotMatch(patched.workflow.fullNegativePrompt, /\u5c38\u4f53/);
  assert.doesNotMatch(patched.storyboard[0].negativePrompt, /\u5c38\u4f53/);
});

test("keeps corpse wording in executable shot text as blocking", () => {
  const raw = baseResult({
    storyboard: [
      {
        ...baseResult().storyboard[0],
        videoPrompt: "\u955c\u5934\u7f13\u6162\u63a8\u8fd1\u5230\u5c38\u4f53\u7ec6\u8282\uff0c\u73af\u5883\u58f0\u538b\u4f4e\u4eba\u7269\u53cd\u5e94\u3002",
      },
    ],
  });
  const gate = evaluateBatchSegmentQuality(raw, { minFullPromptLength: 20 });

  assert.equal(shouldRepairWithCodex(gate), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "sensitive_term"), true);
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

test("moves contract and shot-count failures into the quality gate", () => {
  const contract = {
    segmentIndex: 1,
    title: "第1段｜案情显影",
    sourceText: "调查室里聊天记录成为关键证据。",
    durationSeconds: 10,
    shotCount: 2,
    requiredEvents: ["聊天记录成为关键证据"],
    requiredEventSlots: [
      {
        id: "chat_record_evidence",
        label: "聊天记录成为关键证据",
        mustIncludeAny: ["聊天记录"],
        mustIncludeOneOf: [["证据", "线索"]],
      },
    ],
    forbiddenFutureEvents: ["嫌疑人逃跑"],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_test",
  };
  const raw = baseResult({ duration: "12秒" });
  const gate = evaluateBatchSegmentQuality(raw, {
    contract,
    fullPromptText: "嫌疑人逃跑，调查室只出现普通资料，没有聊天记录证据。",
    minFullPromptLength: 20,
  });

  assert.equal(shouldRepairWithCodex(gate), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "shot_count_mismatch"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "duration_exceeds_contract"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "forbidden_future_event"), true);
  assert.equal(gate.findings.some((finding) => /SegmentContract|requiredEvents|requiredEventSlots/.test(finding.message)), false);
});

test("legacy required event text cannot trigger blocking repair", () => {
  const contract = {
    segmentIndex: 1,
    title: "第1段｜案情显影",
    sourceText: "调查室里聊天记录成为关键证据。",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["聊天记录成为关键证据"],
    requiredEventSlots: [
      {
        id: "chat_record_evidence",
        label: "聊天记录成为关键证据",
        mustIncludeAny: ["聊天记录"],
        mustIncludeOneOf: [["证据", "线索"]],
      },
    ],
    forbiddenFutureEvents: [],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_test",
  };
  const gate = evaluateBatchSegmentQuality(baseResult(), {
    contract,
    fullPromptText: "调查室里只有人物沉默和冷光，没有提到关键材料。",
    minFullPromptLength: 20,
  });

  assert.equal(shouldRepairWithCodex(gate), false);
  assert.equal(gate.warningFindings.some((finding) => finding.code === "weak_required_event_slot"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "missing_required_event_slot"), false);
});

test("structured coverage decisions are the only source of event repair blockers", () => {
  const raw = baseResult();
  const contract = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "test",
    sourceHash: "src_test",
    segmentIndex: 1,
    title: "第1段",
    sourceText: "必须出现关键证据",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["关键证据"],
    requiredEventSlots: [],
    forbiddenFutureEvents: [],
    characterLocks: [],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_test",
  };
  const gate = evaluateBatchSegmentQuality(raw, {
    contract,
    coverageMode: "active",
    coverageDecisions: [{
      segmentIndex: 1,
      slotId: "key_evidence",
      label: "关键证据出现",
      importance: "blocking",
      status: "definite_missing",
      evidencePaths: [],
      evidenceQuotes: [],
      repairTargets: [{ shotNumber: 1, field: "videoPrompt" }],
      repairPaths: ["storyboard[0].videoPrompt"],
      reasonCode: "required_field_empty",
    }],
    fullPromptText: raw.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });

  assert.equal(gate.blockingFindings.some((finding) => finding.code === "missing_required_event_slot"), true);
  assert.equal(gate.blockingFindings.find((finding) => finding.code === "missing_required_event_slot")?.path, "storyboard[0].videoPrompt");
});

test("shadow coverage records confirmed missing events without blocking or repair", () => {
  const raw = baseResult();
  const contract = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "test",
    sourceHash: "src",
    segmentIndex: 1,
    title: "第1段",
    sourceText: "关键证据应出现",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["关键证据"],
    requiredEventSlots: [],
    forbiddenFutureEvents: [],
    characterLocks: [],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_shadow",
  };
  const gate = evaluateBatchSegmentQuality(raw, {
    contract,
    coverageMode: "shadow",
    coverageDecisions: [{
      segmentIndex: 1,
      slotId: "evidence",
      label: "关键证据",
      importance: "blocking",
      status: "definite_missing",
      evidencePaths: [],
      evidenceQuotes: [],
      repairTargets: [{ shotNumber: 1, field: "videoPrompt" }],
      repairPaths: ["storyboard[0].videoPrompt"],
      reasonCode: "required_field_empty",
    }],
    fullPromptText: raw.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });
  assert.equal(gate.warningFindings.some((finding) => finding.code === "missing_required_event_slot"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "missing_required_event_slot"), false);
});

test("reports empty and template-only full prompts through the quality gate", () => {
  const emptyGate = evaluateBatchSegmentQuality(baseResult(), {
    fullPromptText: "",
    minFullPromptLength: 20,
  });
  assert.equal(emptyGate.blockingFindings.some((finding) => finding.code === "empty_full_prompt"), true);

  const templateGate = evaluateBatchSegmentQuality(baseResult(), {
    fullPromptText: "人物、地点和关键物件按案件逻辑分层，缓慢推进后停住，保留北方县城真实空间感。",
    minFullPromptLength: 20,
  });
  assert.equal(templateGate.blockingFindings.some((finding) => finding.code === "template_summary"), true);
});

test("keeps slightly short full prompts patchable when storyboard signal is strong", () => {
  const raw = baseResult({
    storyboard: Array.from({ length: 4 }, (_, index) => ({
      ...baseResult().storyboard[0],
      shotNumber: index + 1,
      scene: `调查室第${index + 1}个角落`,
      visual: `第${index + 1}个镜头里，调查室屏幕、人物侧影和桌面证据形成清晰画面层次。`,
      firstFramePrompt: `第${index + 1}个首帧，调查室冷光照亮屏幕和人物侧脸。`,
      videoPrompt: `第${index + 1}个镜头缓慢推进，屏幕聊天记录与人物反应交替出现，环境声保持克制。`,
      lastFramePrompt: `第${index + 1}个尾帧，人物目光停在屏幕最后一句话上。`,
    })),
  });
  const gate = evaluateBatchSegmentQuality(raw, {
    fullPromptText: "短提示词但 storyboard 信息充足。",
    minFullPromptLength: 260,
  });

  assert.equal(gate.patchableFindings.some((finding) => finding.code === "full_prompt_too_short"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "full_prompt_too_short"), false);
});

test("deterministic quality patch only changes the matched finding path", () => {
  const raw = baseResult();
  const originalVideoPrompt = raw.storyboard[0].videoPrompt;
  const originalLighting = raw.storyboard[0].lighting;
  const patched = applyDeterministicQualityPatchWithDiff(raw, [
    {
      severity: "patchable",
      code: "field_below_target",
      message: "scene is short",
      path: "storyboard[0].scene",
      field: "scene",
      shotNumber: 1,
      currentValue: raw.storyboard[0].scene,
      currentLength: 2,
      minimumLength: 4,
      targetLength: 8,
    },
  ]);

  assert.equal(patched.patchDiffs.length, 1);
  assert.equal(patched.patchDiffs[0].path, "storyboard[0].scene");
  assert.notEqual(patched.result.storyboard[0].scene, raw.storyboard[0].scene);
  assert.equal(patched.result.storyboard[0].videoPrompt, originalVideoPrompt);
  assert.equal(patched.result.storyboard[0].lighting, originalLighting);
});

test("shared safety policy is patched locally instead of forcing Codex repair", () => {
  const raw = baseResult({
    workflow: {
      ...baseResult().workflow,
      fullVideoPrompt: "\u516c\u5b89\u5c40\u95e8\u53e3\u51fa\u73b0\u8b66\u5fbd\uff0c\u4eba\u7269\u5728\u51b7\u5149\u4e2d\u4fdd\u6301\u514b\u5236\u3002",
    },
  });

  const firstGate = evaluateBatchSegmentQuality(raw, {
    fullPromptText: raw.workflow.fullVideoPrompt,
    minFullPromptLength: 20,
  });

  assert.equal(firstGate.findings.some((finding) => finding.code === "sensitive_term"), true);
  assert.equal(shouldRepairWithCodex(firstGate), false);

  const patched = applyDeterministicQualityPatch(raw, firstGate.findings);
  assert.doesNotMatch(patched.workflow.fullVideoPrompt, /\u516c\u5b89\u5c40|\u8b66\u5fbd/);
  assert.match(patched.workflow.fullVideoPrompt, /\u57ce\u5e02\u529e\u6848\u5efa\u7b51|\u673a\u6784\u6807\u8bc6/);
});

test("weak required event slots are warnings, not repair blockers", () => {
  const contract = {
    segmentIndex: 1,
    title: "Segment 1",
    sourceText: "alpha clue",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["alpha clue"],
    requiredEventSlots: [
      {
        id: "alpha_slot",
        label: "alpha clue",
        mustIncludeAny: ["alpha"],
        mustIncludeOneOf: [],
      },
    ],
    forbiddenFutureEvents: [],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_test",
  };
  const gate = evaluateBatchSegmentQuality(baseResult(), {
    contract,
    fullPromptText: "alpha clue is covered in a concrete prompt body.",
    minFullPromptLength: 20,
  });

  assert.equal(gate.warningFindings.some((finding) => finding.code === "weak_required_event_slot"), true);
  assert.equal(gate.blockingFindings.some((finding) => finding.code === "missing_required_event_slot"), false);
  assert.equal(shouldRepairWithCodex(gate), false);
});
