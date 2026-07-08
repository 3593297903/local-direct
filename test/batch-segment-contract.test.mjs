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
  buildSegmentContractHash,
  findMissingSegmentContractRequiredEvents,
  normalizeSegmentContract,
  segmentContractToRenderBlock,
  validateSegmentContract,
} = require("../lib/batch-segment-contract.ts");

test("normalizes a locked segment into a deterministic segment contract", () => {
  const contract = normalizeSegmentContract(
    {
      segmentIndex: 1,
      title: "第1段｜雨夜入口",
      sourceText: "男人在雨夜进入旧楼，发现照片背后的地址。",
      durationSeconds: 12,
      shotCount: 4,
      requiredEvents: ["进入旧楼", "发现地址"],
      forbiddenFutureEvents: ["警方找到真凶"],
      requiredShotBeats: [
        { shotNumber: 1, timeRange: "0s-3s", beat: "雨夜外景", visualFocus: "旧楼入口" },
      ],
    },
    { segmentIndex: 1, fallbackTitle: "第1段", fallbackSourceText: "fallback", fallbackDurationSeconds: 15, fallbackShotCount: 4 },
  );

  assert.equal(contract.segmentIndex, 1);
  assert.equal(contract.durationSeconds, 12);
  assert.equal(contract.shotCount, 4);
  assert.deepEqual(contract.requiredEvents, ["进入旧楼", "发现地址"]);
  assert.deepEqual(contract.forbiddenFutureEvents, ["警方找到真凶"]);
  assert.equal(contract.requiredShotBeats[0].shotNumber, 1);
  assert.doesNotThrow(() => validateSegmentContract(contract, 1));
  assert.match(buildSegmentContractHash(contract), /^sc_[a-z0-9]+$/);
});

test("segment contract render block exposes required and forbidden events to Codex", () => {
  const contract = normalizeSegmentContract(
    {
      segmentIndex: 2,
      title: "第2段｜走廊声响",
      sourceText: "脚步声从走廊尽头传来，门缝下出现一线冷光。",
      durationSeconds: 10,
      shotCount: 3,
      requiredEvents: ["脚步声传来", "门缝冷光"],
      forbiddenFutureEvents: ["看到凶手正脸"],
    },
    { segmentIndex: 2, fallbackTitle: "第2段", fallbackSourceText: "fallback", fallbackDurationSeconds: 10, fallbackShotCount: 3 },
  );

  const block = segmentContractToRenderBlock(contract);
  assert.match(block, /SEGMENT CONTRACT/);
  assert.match(block, /requiredEvents/);
  assert.match(block, /脚步声传来/);
  assert.match(block, /forbiddenFutureEvents/);
  assert.match(block, /看到凶手正脸/);
  assert.match(block, /contractHash/);
});

test("contract event coverage accepts equivalent wording instead of exact sentence matches", () => {
  const contract = normalizeSegmentContract(
    {
      segmentIndex: 17,
      title: "第17段｜夫妻各自的秘密",
      sourceText: "警方继续深挖后发现，庄秦和林六月都有婚外关系。庄秦好色，牌桌、店员和娱乐场所都留下痕迹；林六月也有一个隐秘情人，名叫张庆金，三十五岁，是本市一所中学语文教师。",
      durationSeconds: 13.6,
      shotCount: 5,
      requiredEvents: [
        "查到庄秦有混乱私生活",
        "查到林六月有隐秘情人",
        "首次点出张庆金姓名身份",
        "调查焦点从丈夫转向关系网络",
      ],
      requiredShotBeats: [
        { shotNumber: 1, beat: "警员整理庄秦娱乐场所线索" },
        { shotNumber: 2, beat: "白酒店员工证言剪影" },
        { shotNumber: 3, beat: "苏眉打开林六月网络资料" },
        { shotNumber: 4, beat: "张庆金身份信息出现" },
        { shotNumber: 5, beat: "特案组意识到新嫌疑线" },
      ],
    },
    { segmentIndex: 17, fallbackTitle: "第17段", fallbackSourceText: "fallback", fallbackDurationSeconds: 15, fallbackShotCount: 5 },
  );

  const promptText = [
    "警员把庄秦的牌桌、白酒店和娱乐场所线索贴到白板上，明确庄秦私生活混乱。",
    "苏眉调出林六月的网络资料，发现她长期保留一个隐秘关系，聊天备注指向张庆金。",
    "张庆金第一次以正式档案字段出现：三十五岁，本市一所中学语文教师。",
    "特案组把调查焦点从丈夫庄秦转向更复杂的关系网络，新嫌疑线浮出。",
  ].join("\n");

  assert.deepEqual(findMissingSegmentContractRequiredEvents(promptText, contract), []);
});

test("contract event slots reject prompts missing the required information slot", () => {
  const contract = normalizeSegmentContract(
    {
      segmentIndex: 17,
      title: "第17段｜夫妻各自的秘密",
      sourceText: "林六月的隐秘情人名叫张庆金，三十五岁，是本市一所中学语文教师。",
      durationSeconds: 12,
      shotCount: 4,
      requiredEvents: ["首次点出张庆金姓名身份"],
      requiredEventSlots: [
        {
          id: "zhang_qingjin_identity",
          label: "点出张庆金身份",
          mustIncludeAny: ["张庆金"],
          mustIncludeOneOf: [["三十五岁", "35岁"], ["中学", "语文教师", "教师"]],
        },
      ],
    },
    { segmentIndex: 17, fallbackTitle: "第17段", fallbackSourceText: "fallback", fallbackDurationSeconds: 12, fallbackShotCount: 4 },
  );

  const promptText = "画面只写到林六月有一个隐秘联系人，但没有交代姓名和身份。";

  assert.deepEqual(findMissingSegmentContractRequiredEvents(promptText, contract), ["点出张庆金身份"]);
});
