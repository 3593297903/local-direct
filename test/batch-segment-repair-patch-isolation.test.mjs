import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  applyBatchSegmentRepairPatch,
  assertBatchSegmentRepairPatchIsolation,
} = require("../lib/batch-segment-repair-patch.ts");

function result() {
  return {
    title: "第1段",
    optimizedScript: "原脚本",
    storyboard: [{ shotNumber: 1, visual: "原画面", videoPrompt: "原视频提示词", dialogue: "无" }],
    workflow: { concisePrompt: "原简版", fullVideoPrompt: "原完整提示词" },
  };
}

test("repairs-only merge changes exactly the authorized leaf paths", () => {
  const before = result();
  const after = applyBatchSegmentRepairPatch(before, {
    schemaVersion: 1,
    contractHash: "sc",
    resultHash: "sr",
    repairs: [{ path: "storyboard[0].videoPrompt", replacement: "补齐后的可执行视频提示词", reasonCode: "quality_field" }],
  });
  const changed = assertBatchSegmentRepairPatchIsolation(before, after, ["storyboard[0].videoPrompt"]);
  assert.deepEqual(changed, ["storyboard[0].videoPrompt"]);
  assert.equal(after.storyboard[0].visual, before.storyboard[0].visual);
  assert.equal(after.workflow.fullVideoPrompt, before.workflow.fullVideoPrompt);
});

test("isolation check rejects any unlisted mutation", () => {
  const before = result();
  const after = structuredClone(before);
  after.storyboard[0].videoPrompt = "授权字段";
  after.storyboard[0].visual = "未授权改动";
  assert.throws(
    () => assertBatchSegmentRepairPatchIsolation(before, after, ["storyboard[0].videoPrompt"]),
    /unauthorized fields.*visual/i,
  );
});
