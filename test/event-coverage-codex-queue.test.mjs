import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  claimNextEventCoverageCodexJob,
  completeEventCoverageCodexJob,
  createEventCoverageCodexJob,
  failEventCoverageCodexJob,
  getEventCoverageCodexJob,
} = require("../lib/event-coverage-codex-queue.ts");

function root() {
  return path.join(os.tmpdir(), `localdirector-event-judge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function input() {
  return {
    batchId: "batch-test",
    waveId: "wave-1",
    cases: [{
      segmentIndex: 25,
      slotId: "cold_marriage",
      label: "庄秦承认夫妻关系长期冷淡",
      importance: "blocking",
      contractHash: "sc_test",
      resultHash: "sr_test",
      anchorGroups: [["庄秦", "丈夫"]],
      conceptGroups: [["承认", "表示"], ["婚姻冷淡", "没什么感情"]],
      contradictionGroups: [["夫妻感情很好"]],
      sourceExcerpt: "庄秦接受询问并承认夫妻关系早已冷淡。",
      characterLocks: [{
        characterId: "zhuang_qin",
        displayName: "庄秦",
        factKey: "婚姻状态",
        expectedValue: "夫妻关系冷淡",
        mode: "must_not_contradict",
        contradictionSignals: [["夫妻感情很好"]],
      }],
      forbiddenFutureEvents: ["下一段才出现的认罪"],
      evidenceSelectors: [{
        source: "storyboard",
        shotNumber: "any",
        fields: ["dialogue"],
        requireExecutableShot: true,
      }],
      inspectedFields: [{ path: "storyboard[0].dialogue", text: "庄秦：我们夫妻，早就没什么感情了。" }],
    }],
  };
}

test("judge queue is idempotent, atomically claimed, and accepts only strict decisions", async () => {
  const rootDir = root();
  try {
    const created = await createEventCoverageCodexJob(input(), { rootDir });
    const duplicate = await createEventCoverageCodexJob(input(), { rootDir });
    assert.equal(duplicate.id, created.id);
    assert.match(created.prompt, /decisions-only/i);
    assert.doesNotMatch(created.prompt, /workflow\.fullVideoPrompt/);

    const [first, second] = await Promise.all([
      claimNextEventCoverageCodexJob({ rootDir }),
      claimNextEventCoverageCodexJob({ rootDir }),
    ]);
    const claimed = first || second;
    assert.ok(claimed?.leaseId);
    assert.equal([first, second].filter(Boolean).length, 1);

    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: 1,
      waveId: "wave-1",
      decisions: [{
        segmentIndex: 25,
        slotId: "cold_marriage",
        status: "covered",
        evidence: [{ path: "storyboard[0].dialogue", quote: "早就没什么感情了" }],
        inspectedPaths: ["storyboard[0].dialogue"],
      }],
    }), "utf8");
    const completed = await completeEventCoverageCodexJob(claimed.id, claimed.leaseId, { rootDir });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.decisions[0].status, "covered");
    assert.equal((await getEventCoverageCodexJob(created.id, { rootDir })).status, "completed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("judge queue rejects repair payloads, downgrades fake quotes, and rejects stale leases", async () => {
  const rootDir = root();
  try {
    const job = await createEventCoverageCodexJob(input(), { rootDir });
    const claimed = await claimNextEventCoverageCodexJob({ rootDir });
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: 1,
      waveId: "wave-1",
      repairs: [{ path: "storyboard[0].dialogue", replacement: "改写" }],
    }), "utf8");
    await assert.rejects(
      () => completeEventCoverageCodexJob(job.id, claimed.leaseId, { rootDir }),
      /decisions-only/i,
    );

    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: 1,
      waveId: "wave-1",
      decisions: [{
        segmentIndex: 25,
        slotId: "cold_marriage",
        status: "covered",
        evidence: [{ path: "storyboard[0].dialogue", quote: "不存在的引用" }],
        inspectedPaths: ["storyboard[0].dialogue"],
      }],
    }), "utf8");
    await assert.rejects(
      () => failEventCoverageCodexJob(job.id, "stale-lease", "failed", { rootDir }),
      /lease/i,
    );
    const uncertain = await completeEventCoverageCodexJob(job.id, claimed.leaseId, { rootDir });
    assert.equal(uncertain.result.decisions[0].status, "uncertain");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("judge evidence from model-safe text maps back to the current original field", async () => {
  const rootDir = root();
  try {
    const safeInput = input();
    safeInput.waveId = "wave-safe";
    safeInput.cases[0].sourceExcerpt = "公安局审讯室里，庄秦承认夫妻关系冷淡。";
    safeInput.cases[0].inspectedFields = [{
      path: "storyboard[0].dialogue",
      text: "公安局审讯室里，庄秦说夫妻早就没什么感情。",
    }];
    const job = await createEventCoverageCodexJob(safeInput, { rootDir });
    const claimed = await claimNextEventCoverageCodexJob({ rootDir });
    assert.match(claimed.prompt, /城市办案建筑/);
    assert.doesNotMatch(claimed.prompt, /公安局/);
    mkdirSync(path.dirname(claimed.outputPath), { recursive: true });
    writeFileSync(claimed.outputPath, JSON.stringify({
      schemaVersion: 1,
      waveId: "wave-safe",
      decisions: [{
        segmentIndex: 25,
        slotId: "cold_marriage",
        status: "covered",
        evidence: [{ path: "storyboard[0].dialogue", quote: "城市办案建筑" }],
        inspectedPaths: ["storyboard[0].dialogue"],
      }],
    }), "utf8");
    const completed = await completeEventCoverageCodexJob(job.id, claimed.leaseId, { rootDir });
    assert.equal(completed.result.decisions[0].status, "covered");
    assert.equal(completed.result.decisions[0].evidence[0].quote, "公安局");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
