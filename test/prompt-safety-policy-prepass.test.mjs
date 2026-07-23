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
  applyPromptSafetyPolicyDeep,
  applyPromptSafetyPolicy,
} = require("../lib/prompt-safety-policy.ts");
const {
  compileCodexPromptValueForModel,
  compileCodexPromptText,
} = require("../lib/codex-prompt-input-compiler.ts");

test("prompt safety prepass keeps original text while producing model-safe text and diffs", () => {
  const source = {
    title: "case",
    sourceText: "\u516c\u5b89\u5c40\u95e8\u53e3\u6709\u8b66\u5fbd\uff0c\u5730\u9762\u6709\u8840\u6cca\u3002",
    storyboard: [
      {
        negativePrompt: "\u4e0d\u8981\u5c38\u4f53\u7ec6\u8282\uff0c\u4e0d\u8981\u4f4e\u6e05\u753b\u9762\u3002",
      },
    ],
  };

  const prepass = applyPromptSafetyPolicyDeep(source, { phase: "render" });

  assert.equal(prepass.sourceTextOriginal, source);
  assert.match(prepass.sourceTextOriginal.sourceText, /\u516c\u5b89\u5c40/);
  assert.doesNotMatch(prepass.sourceTextForModel.sourceText, /\u516c\u5b89\u5c40|\u8b66\u5fbd|\u8840\u6cca/);
  assert.doesNotMatch(prepass.sourceTextForModel.storyboard[0].negativePrompt, /\u5c38\u4f53/);
  assert.ok(prepass.safetyDiffs.length >= 3);
  assert.ok(prepass.safetyDiffs.some((diff) => diff.path === "sourceText"));
  assert.ok(["medium", "high"].includes(prepass.highestRisk));
});

test("codex prompt compiler hides internal IDs and applies local safety wording before generation", () => {
  const compiledText = compileCodexPromptText(
    "Open chat-log and qq_records inside forensic_room near \u516c\u5b89\u5c40.",
    { phase: "render" },
  );

  assert.doesNotMatch(compiledText, /chat-log|qq_records|forensic_room/i);
  assert.doesNotMatch(compiledText, /\u516c\u5b89\u5c40/);

  const compiledValue = compileCodexPromptValueForModel(
    { sourceText: "case-room\u91cc\u6709 chat-log \u548c \u516c\u5b89\u5c40\u8bb0\u5f55" },
    { phase: "planning" },
  );

  assert.match(compiledValue.sourceTextOriginal.sourceText, /chat-log/);
  assert.doesNotMatch(compiledValue.sourceTextForModel.sourceText, /chat-log|case-room|\u516c\u5b89\u5c40/i);
  assert.ok(compiledValue.safetyDiffs.length >= 1);

  const direct = applyPromptSafetyPolicy("\u516c\u5b89\u5c40", { phase: "render" });
  assert.doesNotMatch(direct.text, /\u516c\u5b89\u5c40/);
});
