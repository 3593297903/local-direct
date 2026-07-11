import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const { validateBatchSegmentRepairPatchResult } = require("../lib/batch-segment-repair-patch.ts");

const options = {
  contractHash: "sc_contract",
  resultHash: "sr_result",
  allowedPaths: ["storyboard[0].videoPrompt"],
  allowedSlotIds: ["slot-1"],
  currentValues: { "storyboard[0].videoPrompt": "old value" },
};

function payload(schemaVersion) {
  return {
    schemaVersion,
    contractHash: "sc_contract",
    resultHash: "sr_result",
    repairs: [{
      path: "storyboard[0].videoPrompt",
      replacement: "新的可执行中文镜头描述",
      reasonCode: "quality_field",
      slotId: null,
    }],
  };
}

test("repair schema accepts only numeric-equivalent version one forms", () => {
  for (const version of [1, 1.0, "1", "1.0", "1.00", " 1.0 "]) {
    assert.equal(validateBatchSegmentRepairPatchResult(payload(version), options).schemaVersion, 1);
  }
  for (const version of [true, [1], { value: 1 }, 1.1, 2, "", "01", "1.0.0"]) {
    assert.throws(() => validateBatchSegmentRepairPatchResult(payload(version), options), /schema/i);
  }
});

test("repair worker leaves protocol validation to the server authority", () => {
  const worker = readFileSync(path.join(process.cwd(), "scripts", "batch-segment-repair-codex-worker.mjs"), "utf8");
  assert.doesNotMatch(worker, /result\.schemaVersion\s*!==\s*1/);
  assert.match(worker, /Repair patch JSON is missing protocol fields/);
  assert.match(worker, /JOB_STORAGE_BUSY/);
});
