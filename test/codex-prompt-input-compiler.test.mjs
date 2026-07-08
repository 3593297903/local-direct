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
