import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { normalizeSegmentContract } = require("../lib/batch-segment-contract.ts");
const {
  buildSegmentResultHash,
  validateSegmentEventCoverage,
} = require("../lib/batch-event-coverage.ts");

function makeResult(shots, optimizedScript = "") {
  return {
    title: "测试段",
    contentType: "短剧",
    duration: "12秒",
    style: "写实",
    diagnosis: [],
    optimizedScript,
    workflow: {
      fullVideoPrompt: shots.map((shot) => `${shot.visual || ""}${shot.dialogue || ""}${shot.videoPrompt || ""}`).join("\n"),
      fullNegativePrompt: "避免不相关元素",
      concisePrompt: "测试段落",
    },
    storyboard: shots.map((shot, index) => ({ shotNumber: index + 1, ...shot })),
    recommendedItems: [],
    editingNotes: [],
  };
}

function makeContract(raw) {
  return normalizeSegmentContract(raw, {
    segmentIndex: raw.segmentIndex || 1,
    fallbackTitle: "测试段",
    fallbackSourceText: raw.sourceText || "测试原文",
    fallbackDurationSeconds: 12,
    fallbackShotCount: raw.shotCount || 2,
  });
}

test("local coverage accepts equivalent wording for a cold marriage without a judge", () => {
  const contract = makeContract({
    segmentIndex: 25,
    sourceText: "庄秦承认婚姻长期冷淡。",
    durationSeconds: 12,
    shotCount: 2,
    requiredEvents: ["庄秦承认夫妻关系长期冷淡"],
    requiredEventSlots: [{
      id: "cold_marriage",
      label: "庄秦承认夫妻关系长期冷淡",
      importance: "blocking",
      anchorGroups: [["庄秦", "丈夫"]],
      conceptGroups: [["承认", "表示", "说"], ["婚姻冷淡", "夫妻没什么感情", "早就没什么感情", "关系疏离"]],
      contradictionGroups: [["夫妻感情很好", "婚姻幸福"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["dialogue", "visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "dialogue" }],
    }],
  });
  const result = makeResult([
    { visual: "庄秦低头坐在桌边。", dialogue: "庄秦：我们夫妻，早就没什么感情了。" },
    { visual: "调查员记录口供。", dialogue: "无" },
  ]);

  const decisions = validateSegmentEventCoverage(result, contract);
  assert.equal(decisions[0].status, "covered");
  assert.equal(decisions[0].reasonCode, "verified_local_bundle");
});

test("local coverage combines visual and dialogue in one shot for recognition", () => {
  const contract = makeContract({
    segmentIndex: 26,
    sourceText: "大妈看照片后认出邻居老周。",
    durationSeconds: 12,
    shotCount: 2,
    requiredEvents: ["大妈认出照片中的邻居"],
    requiredEventSlots: [{
      id: "neighbor_recognition",
      label: "大妈认出照片中的邻居",
      importance: "blocking",
      anchorGroups: [["大妈", "邻居大妈"]],
      conceptGroups: [["照片", "相片"], ["认出", "这是隔壁老周", "是老周"]],
      contradictionGroups: [["没认出来", "认不出来", "不认识"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual", "dialogue"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "dialogue" }],
    }],
  });
  const result = makeResult([
    { visual: "大妈接过照片，眯起眼仔细端详。", dialogue: "大妈：这不是隔壁老周吗？" },
    { visual: "调查员交换眼神。", dialogue: "无" },
  ]);

  assert.equal(validateSegmentEventCoverage(result, contract)[0].status, "covered");
});

test("negated recognition is not accepted as positive coverage", () => {
  const contract = makeContract({
    segmentIndex: 26,
    sourceText: "大妈需要辨认照片人物。",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["大妈认出照片中的邻居"],
    requiredEventSlots: [{
      id: "neighbor_recognition",
      label: "大妈认出照片中的邻居",
      importance: "blocking",
      anchorGroups: [["大妈"]],
      conceptGroups: [["照片"], ["认出", "是老周"]],
      contradictionGroups: [["没认出来", "认不出来", "不认识"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual", "dialogue"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: 1, field: "dialogue" }],
    }],
  });
  const result = makeResult([{ visual: "大妈看着照片。", dialogue: "大妈：看不清，我没认出来。" }]);

  assert.equal(validateSegmentEventCoverage(result, contract)[0].status, "contradiction");
});

test("continuity locks only block explicit contradictions", () => {
  const contract = makeContract({
    segmentIndex: 6,
    sourceText: "二宝赶到护栏边救人。",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["二宝参与护栏救援"],
    characterLocks: [{
      characterId: "erbao",
      displayName: "二宝",
      factKey: "occupation",
      expectedValue: "巡警",
      mode: "must_not_contradict",
      contradictionSignals: [["辞职", "离开警队"], ["被开除", "不再是警员"], ["冒充警察"]],
    }],
  });

  const omitted = makeResult([{ visual: "二宝跑向护栏，扶住即将跌倒的孩子。", dialogue: "无" }]);
  const preserved = makeResult([{ visual: "二宝没有脱离巡警身份，继续维持现场秩序。", dialogue: "无" }]);
  const contradicted = makeResult([{ visual: "二宝已经离开警队，以普通路人身份经过。", dialogue: "无" }]);

  assert.equal(validateSegmentEventCoverage(omitted, contract).some((item) => item.status === "contradiction"), false);
  assert.equal(validateSegmentEventCoverage(preserved, contract).some((item) => item.status === "contradiction"), false);
  assert.equal(validateSegmentEventCoverage(contradicted, contract).some((item) => item.status === "contradiction"), true);
});

test("invalid sidecar evidence never proves coverage", () => {
  const contract = makeContract({
    segmentIndex: 1,
    sourceText: "大妈认出照片中的邻居。",
    durationSeconds: 12,
    shotCount: 1,
    requiredEvents: ["大妈认出照片中的邻居"],
    requiredEventSlots: [{
      id: "recognition",
      label: "大妈认出照片中的邻居",
      importance: "blocking",
      anchorGroups: [["大妈"]],
      conceptGroups: [["认出"]],
      contradictionGroups: [],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["dialogue"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: 1, field: "dialogue" }],
    }],
  });
  const result = makeResult([{ visual: "大妈拿着照片。", dialogue: "无" }]);
  const sidecar = {
    schemaVersion: 1,
    segmentIndex: 1,
    contractHash: contract.contractHash,
    resultHash: buildSegmentResultHash(result),
    receipts: [{ slotId: "recognition", evidence: [{ path: "storyboard[0].dialogue", quote: "这是老周" }] }],
  };

  const decision = validateSegmentEventCoverage(result, contract, sidecar)[0];
  assert.equal(decision.status, "ambiguous");
  assert.equal(decision.reasonCode, "quote_not_found");
});
