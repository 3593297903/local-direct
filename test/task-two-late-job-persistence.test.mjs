import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const queue = require("../lib/batch-segment-repair-codex-queue.ts");

test("late repair completion remains queryable and duplicate create never reruns Codex", async () => {
  const rootDir = path.join(os.tmpdir(), `localdirector-late-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const input = {
    batchId: "batch-late",
    segmentIndex: 1,
    slotId: "slot-late",
    contractHash: "sc-late",
    resultHash: "sr-late",
    sourceTextForModel: "source text for a late repair result",
    allowedPaths: ["storyboard[0].videoPrompt"],
    currentValues: { "storyboard[0].videoPrompt": "old" },
    findings: [{ code: "missing", message: "missing detail", path: "storyboard[0].videoPrompt", slotId: "slot-late" }],
  };
  try {
    const concurrentCreates = await Promise.all(Array.from({ length: 20 }, () =>
      queue.createBatchSegmentRepairCodexJob(input, { rootDir })));
    const created = concurrentCreates[0];
    assert.equal(new Set(concurrentCreates.map((job) => job.id)).size, 1);
    const claimed = await queue.claimNextBatchSegmentRepairCodexJob({ rootDir, workerId: "worker-a" });
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: "1.0",
      contractHash: "sc-late",
      resultHash: "sr-late",
      repairs: [{ slotId: "slot-late", path: "storyboard[0].videoPrompt", replacement: "迟到但有效的中文镜头描述", reasonCode: "missing_event" }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const completed = await queue.getBatchSegmentRepairCodexJob(claimed.id, { rootDir });
    assert.equal(completed.status, "completed");
    const repeatedComplete = await queue.completeBatchSegmentRepairCodexJob(
      claimed.id,
      claimed.leaseId,
      claimed.fencingToken,
      { rootDir },
    );
    assert.equal(repeatedComplete.id, completed.id);
    assert.deepEqual(repeatedComplete.result, completed.result);
    const duplicate = await queue.createBatchSegmentRepairCodexJob(input, { rootDir });
    assert.equal(duplicate.id, created.id);
    assert.equal(duplicate.status, "completed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
