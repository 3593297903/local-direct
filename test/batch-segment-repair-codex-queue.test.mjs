import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  claimNextBatchSegmentRepairCodexJob,
  completeBatchSegmentRepairCodexJob,
  createBatchSegmentRepairCodexJob,
  getBatchSegmentRepairCodexJob,
} = require("../lib/batch-segment-repair-codex-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-segment-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function createInput(overrides = {}) {
  return {
    batchId: "batch-001",
    segmentIndex: 6,
    slotId: "erbao_police_identity",
    contractHash: "sc_contract",
    resultHash: "sr_result",
    sourceTextForModel: "二宝以巡警身份在护栏旁执勤。",
    allowedPaths: ["storyboard[3].shotPurpose", "storyboard[3].videoPrompt"],
    currentValues: {
      "storyboard[3].shotPurpose": "承接下一段。",
      "storyboard[3].videoPrompt": "二宝站在护栏旁。",
    },
    findings: [
      {
        code: "missing_required_event_slot",
        message: "缺少二宝巡警身份的可执行表达",
        path: "storyboard[3].shotPurpose",
        slotId: "erbao_police_identity",
      },
    ],
    forbiddenFutureEvents: ["提前揭示张庆金身份"],
    ...overrides,
  };
}

test("repair queue creates a repairs-only prompt and completes a strict patch result", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createBatchSegmentRepairCodexJob(createInput(), { rootDir });
    assert.equal(job.status, "pending");
    assert.match(job.prompt, /repairs/);
    assert.match(job.prompt, /storyboard\[3\]\.shotPurpose/);
    assert.doesNotMatch(job.prompt, /workflow\.fullVideoPrompt/);
    assert.doesNotMatch(job.prompt, /完整结果 JSON/);

    const claimed = await claimNextBatchSegmentRepairCodexJob({ rootDir });
    assert.ok(claimed);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");
    assert.ok(claimed.leaseId);

    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: 1,
      contractHash: "sc_contract",
      resultHash: "sr_result",
      repairs: [
        {
          slotId: "erbao_police_identity",
          path: "storyboard[3].shotPurpose",
          replacement: "明确二宝仍是正在护栏旁执勤的巡警，并承接下一段救援。",
          reasonCode: "missing_event",
        },
      ],
    }, null, 2));

    const completed = await completeBatchSegmentRepairCodexJob(claimed.id, claimed.leaseId, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.repairs.length, 1);

    const reloaded = await getBatchSegmentRepairCodexJob(job.id, { rootDir });
    assert.equal(reloaded.result.repairs[0].path, "storyboard[3].shotPurpose");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repair queue rejects complete AnalysisResult fallback and unauthorized paths", async () => {
  const rootDir = makeTempRoot();
  try {
    const first = await createBatchSegmentRepairCodexJob(createInput(), { rootDir });
    const firstClaim = await claimNextBatchSegmentRepairCodexJob({ rootDir });
    mkdirSync(path.dirname(firstClaim.outputPath), { recursive: true });
    writeFileSync(firstClaim.outputPath, JSON.stringify({
      title: "完整候选结果",
      storyboard: [],
      workflow: { fullVideoPrompt: "不允许" },
    }));
    await assert.rejects(
      () => completeBatchSegmentRepairCodexJob(first.id, firstClaim.leaseId, { rootDir }),
      /repairs-only|repairs/i,
    );

    const second = await createBatchSegmentRepairCodexJob(createInput({ batchId: "batch-002", resultHash: "sr_result_2" }), { rootDir });
    const secondClaim = await claimNextBatchSegmentRepairCodexJob({ rootDir });
    writeFileSync(secondClaim.outputPath, JSON.stringify({
      schemaVersion: 1,
      contractHash: "sc_contract",
      resultHash: "sr_result_2",
      repairs: [{
        slotId: "erbao_police_identity",
        path: "workflow.fullVideoPrompt",
        replacement: "越权修改",
        reasonCode: "missing_event",
      }],
    }));
    await assert.rejects(
      () => completeBatchSegmentRepairCodexJob(second.id, secondClaim.leaseId, { rootDir }),
      /unauthorized|path/i,
    );

    const third = await createBatchSegmentRepairCodexJob(createInput({ batchId: "batch-003", resultHash: "sr_result_3" }), { rootDir });
    const thirdClaim = await claimNextBatchSegmentRepairCodexJob({ rootDir });
    writeFileSync(thirdClaim.outputPath, JSON.stringify({
      schemaVersion: 1,
      contractHash: "sc_contract",
      resultHash: "sr_result_3",
      repairs: [{
        slotId: "unknown_slot",
        path: "storyboard[3].shotPurpose",
        replacement: "修复内容",
        reasonCode: "missing_event",
      }],
    }));
    await assert.rejects(
      () => completeBatchSegmentRepairCodexJob(third.id, thirdClaim.leaseId, { rootDir }),
      /unknown slotId/i,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repair queue atomically claims one pending job across concurrent workers", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createBatchSegmentRepairCodexJob(createInput(), { rootDir });
    const duplicate = await createBatchSegmentRepairCodexJob(createInput(), { rootDir });
    assert.equal(duplicate.id, job.id);
    assert.equal(duplicate.idempotencyKey, job.idempotencyKey);
    const claims = await Promise.all([
      claimNextBatchSegmentRepairCodexJob({ rootDir }),
      claimNextBatchSegmentRepairCodexJob({ rootDir }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean).id, job.id);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repair idempotency is slot durable and does not change with resultHash", async () => {
  const rootDir = makeTempRoot();
  try {
    const first = await createBatchSegmentRepairCodexJob(createInput({ resultHash: "sr_before" }), { rootDir });
    const duplicate = await createBatchSegmentRepairCodexJob(createInput({ resultHash: "sr_after" }), { rootDir });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.idempotencyKey, first.idempotencyKey);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
