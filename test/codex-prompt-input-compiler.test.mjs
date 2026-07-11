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
  assertCleanCodexPromptInput,
  buildChinesePromptLexiconBlock,
  compileSegmentContractRenderBlock,
  compileCodexPromptText,
  segmentContractToChineseRenderBlock,
} = require("../lib/codex-prompt-input-compiler.ts");

test("compiles known internal prompt tokens into Chinese before Codex sees them", () => {
  const compiled = compileCodexPromptText("Open chat-log, qq_records, forensic_room, and single-segment AnalysisResult.");

  assert.doesNotMatch(compiled, /chat-log|qq_records|forensic_room|single-segment|AnalysisResult/i);
  assert.match(compiled, /聊天记录证据/);
  assert.match(compiled, /QQ聊天记录/);
  assert.match(compiled, /法医室/);
  assert.match(compiled, /单段视频提示词结果/);
  assert.doesNotThrow(() => assertCleanCodexPromptInput(compiled, "compiled test prompt"));
});

test("rejects prompts that still contain internal tokens before generation", () => {
  assert.throws(
    () => assertCleanCodexPromptInput("Use qq_records in the generated prompt.", "dirty test prompt"),
    /contains internal prompt token/,
  );
});

test("formats segment contracts as Chinese render blocks instead of raw JSON schema text", () => {
  const block = segmentContractToChineseRenderBlock({
    segmentIndex: 1,
    title: "第1段",
    sourceText: "case-room 中打开 chat-log。",
    durationSeconds: 15,
    shotCount: 4,
    requiredEvents: ["chat-log 被读取"],
    forbiddenFutureEvents: ["future event"],
    characters: [],
    locations: [{ name: "case-room" }],
    props: [{ name: "qq_records" }],
    requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-3s", beat: "chat-log", visualFocus: "forensic_room" }],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_test",
  });

  assert.match(block, /段落契约/);
  assert.match(block, /专案会议室/);
  assert.match(block, /QQ聊天记录/);
  assert.match(block, /聊天记录证据/);
  assert.doesNotMatch(block, /SegmentContract|qq_records|chat-log|forensic_room|case-room/);
});

test("builds a Chinese-only lexicon block from dirty input values", () => {
  const block = buildChinesePromptLexiconBlock(["chat-log", "qq_records", "forensic_room"]);

  assert.match(block, /项目中文词典/);
  assert.match(block, /聊天记录证据/);
  assert.match(block, /QQ聊天记录/);
  assert.match(block, /法医室/);
  assert.doesNotMatch(block, /chat-log|qq_records|forensic_room/);
});

test("compact render contracts expose blocking sidecar slots without literal requiredEvents matching", () => {
  const contract = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "policy-test",
    sourceHash: "src_test",
    segmentIndex: 25,
    title: "婚姻关系调查",
    sourceText: "庄秦承认夫妻早已没有感情。",
    durationSeconds: 12,
    shotCount: 3,
    requiredEvents: ["婚姻冷淡"],
    requiredEventSlots: [{
      id: "cold_marriage",
      label: "庄秦承认夫妻关系长期冷淡",
      importance: "blocking",
      anchorGroups: [["庄秦", "丈夫"]],
      conceptGroups: [["夫妻", "婚姻"], ["没感情", "冷淡", "疏离"]],
      contradictionGroups: [["感情很好", "婚姻和睦"]],
      evidenceSelectors: [
        { source: "optimizedScript", fields: ["dialogue"], requireExecutableShot: false },
        { source: "storyboard", shotNumber: "any", fields: ["dialogue", "visual"], requireExecutableShot: true },
      ],
      repairTargets: [{ shotNumber: "best_match", field: "dialogue" }],
    }, {
      id: "advisory_note",
      label: "只记录的次要事件",
      importance: "advisory",
      anchorGroups: [["次要人物"]],
      conceptGroups: [["经过"]],
      contradictionGroups: [],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
    forbiddenFutureEvents: ["后续嫌疑人被捕"],
    characterLocks: [{
      characterId: "zhuangqin",
      displayName: "庄秦",
      factKey: "marital_status",
      expectedValue: "婚姻关系仍存续",
      mode: "must_not_contradict",
      contradictionSignals: [["已经离婚"]],
    }],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-4s", beat: "调查", visualFocus: "办公室" }],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_cold_marriage",
  };

  const compiled = compileSegmentContractRenderBlock(contract);
  assert.match(compiled.text, /cold_marriage/);
  assert.match(compiled.text, /evidenceSelectors|允许证据路径/);
  assert.match(compiled.text, /optimizedScript/);
  assert.match(compiled.text, /storyboard\[\*\]\.dialogue/);
  assert.match(compiled.text, /没有提及.*不算冲突/);
  assert.match(compiled.text, /剧情理解参考.*不做逐字匹配/);
  assert.doesNotMatch(compiled.text, /必须覆盖所有必须事件/);
  assert.doesNotMatch(compiled.text, /advisory_note/);
  assert.ok(compiled.byteLength <= 3072);
  assert.equal(compiled.wasCompacted, false);
});
