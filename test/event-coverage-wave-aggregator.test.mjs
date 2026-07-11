import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const queue = require("../lib/event-coverage-codex-queue.ts");
const aggregator = require("../lib/event-coverage-wave-aggregator.ts");

function judgeCase(segmentIndex) {
  return {
    segmentIndex,
    slotId: `slot_${segmentIndex}`,
    label: `事件 ${segmentIndex}`,
    importance: "blocking",
    contractHash: `sc_${segmentIndex}`,
    resultHash: `sr_${segmentIndex}`,
    anchorGroups: [[`人物${segmentIndex}`]],
    conceptGroups: [["承认"]],
    contradictionGroups: [],
    sourceExcerpt: `人物${segmentIndex}承认事件。`,
    characterLocks: [],
    forbiddenFutureEvents: [],
    evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["dialogue"], requireExecutableShot: true }],
    inspectedFields: [{ path: "storyboard[0].dialogue", text: `人物${segmentIndex}承认事件。` }],
  };
}

test("concurrent render packs in one round share a single Judge wave", async () => {
  const original = queue.createEventCoverageCodexJob;
  const rootDir = path.join(os.tmpdir(), `event-wave-${Date.now()}`);
  let calls = 0;
  queue.createEventCoverageCodexJob = async (input) => {
    calls += 1;
    return original(input, { rootDir });
  };
  try {
    const [left, right] = await Promise.all([
      aggregator.enqueueEventCoverageJudgeWave({ batchId: "batch", renderRound: 1, cases: [judgeCase(1)], aggregationWindowMs: 300 }),
      aggregator.enqueueEventCoverageJudgeWave({ batchId: "batch", renderRound: 1, cases: [judgeCase(2)], aggregationWindowMs: 300 }),
    ]);
    assert.equal(left.id, right.id);
    assert.equal(left.cases.length, 2);
    assert.equal(calls, 1);
  } finally {
    queue.createEventCoverageCodexJob = original;
    aggregator.resetEventCoverageWaveAggregatorForTests();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
