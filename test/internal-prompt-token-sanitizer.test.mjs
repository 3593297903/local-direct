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
  findInternalPromptToken,
  sanitizeInternalPromptTokens,
  sanitizeInternalPromptTokensDeep,
} = require("../lib/internal-prompt-token-sanitizer.ts");

test("sanitizes internal render labels and asset ids into Chinese user-facing text", () => {
  const text = [
    "contentType: single-segment AnalysisResult",
    "scene: forensic_room and case-room",
    "props: chat-log, digital-records, video_prompt_segment",
  ].join("\n");

  const sanitized = sanitizeInternalPromptTokens(text);

  assert.doesNotMatch(sanitized, /single-segment|AnalysisResult|forensic_room|case-room|chat-log|digital-records|video_prompt_segment/i);
  assert.match(sanitized, /单段视频提示词结果/);
  assert.match(sanitized, /法医室/);
  assert.match(sanitized, /专案会议室/);
  assert.match(sanitized, /聊天记录证据/);
  assert.match(sanitized, /数字证据/);
});

test("deep sanitizer cleans nested prompt result objects without changing structure", () => {
  const value = {
    contentType: "single-segment AnalysisResult",
    workflow: {
      fullVideoPrompt: "chat-log 在 digital-records 中被打开。",
    },
    storyboard: [
      {
        scene: "case-room",
        videoPrompt: "镜头扫过 forensic_room。",
      },
    ],
  };

  const sanitized = sanitizeInternalPromptTokensDeep(value);

  assert.equal(sanitized.contentType, "单段视频提示词结果");
  assert.equal(sanitized.workflow.fullVideoPrompt, "聊天记录证据 在 数字证据 中被打开。");
  assert.equal(sanitized.storyboard[0].scene, "专案会议室");
  assert.equal(sanitized.storyboard[0].videoPrompt, "镜头扫过 法医室。");
});

test("detects internal tokens before saving user-facing prompt text", () => {
  assert.equal(findInternalPromptToken("chat-log")?.token, "chat-log");
  assert.equal(findInternalPromptToken("自然中文提示词"), null);
});
