import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createBatchInvocationLedger,
  decideLateRepairMerge,
  shouldContinueDetachedRepairObservation,
} = require("../lib/batch-repair-scheduler.ts");

test("completed matching repair merges once before save", () => {
  const decision = decideLateRepairMerge({
    jobId: "job-1",
    activeRepairJobId: "job-1",
    jobStatus: "completed",
    expectedContractHash: "c",
    currentContractHash: "c",
    expectedResultHash: "r",
    currentResultHash: "r",
    mergedJobIds: new Set(),
    saveStatus: "cached",
  });
  assert.equal(decision.action, "merge");
});

test("completed repair after review save becomes an explicit late patch", () => {
  const decision = decideLateRepairMerge({
    jobId: "job-2",
    activeRepairJobId: "job-2",
    jobStatus: "completed",
    expectedContractHash: "c",
    currentContractHash: "c",
    expectedResultHash: "r",
    currentResultHash: "r",
    mergedJobIds: new Set(),
    saveStatus: "review_saved",
  });
  assert.equal(decision.action, "late_patch_available");
});

test("stale hashes and duplicate jobs are archived without overwrite or regeneration", () => {
  assert.equal(decideLateRepairMerge({
    jobId: "job-3",
    activeRepairJobId: "job-3",
    jobStatus: "completed",
    expectedContractHash: "old",
    currentContractHash: "new",
    expectedResultHash: "r",
    currentResultHash: "r",
    mergedJobIds: new Set(),
    saveStatus: "cached",
  }).action, "archive_stale");
  assert.equal(decideLateRepairMerge({
    jobId: "job-4",
    activeRepairJobId: "job-4",
    jobStatus: "completed",
    expectedContractHash: "c",
    currentContractHash: "c",
    expectedResultHash: "r",
    currentResultHash: "r",
    mergedJobIds: new Set(["job-4"]),
    saveStatus: "cached",
  }).action, "ignore_duplicate");
});

test("a detached repair completed at minute twenty merges the original job", () => {
  const decision = decideLateRepairMerge({
    jobId: "job-detached-12m",
    activeRepairJobId: "job-detached-12m",
    jobStatus: "completed",
    expectedContractHash: "contract-a",
    currentContractHash: "contract-a",
    expectedResultHash: "result-a",
    currentResultHash: "result-a",
    mergedJobIds: new Set(),
    saveStatus: "cached",
  });
  assert.equal(decision.action, "merge");
});

test("detached repair observation remains active at minute twenty and stops after the final deadline", () => {
  const detachedAt = 1_000;
  assert.equal(shouldContinueDetachedRepairObservation({ detachedAt, now: detachedAt + 12 * 60_000 }), true);
  assert.equal(shouldContinueDetachedRepairObservation({ detachedAt, now: detachedAt + 20 * 60_000 }), true);
  assert.equal(shouldContinueDetachedRepairObservation({ detachedAt, now: detachedAt + 31 * 60_000 }), false);
});

test("invocation ledger restores without adding model calls", () => {
  const original = createBatchInvocationLedger();
  original.record("renderPackCalls", { count: 5 });
  original.record("judgeCalls", { count: 1 });
  const restored = createBatchInvocationLedger(original.summary().events);
  assert.equal(restored.summary().renderPackCalls, 5);
  assert.equal(restored.summary().judgeCalls, 1);
  assert.equal(restored.summary().singleRegenerationCalls, 0);
  assert.equal(restored.summary().pathPatchJobCreated, 0);
});

test("a completed repair waits while the matching segment is still saving", () => {
  const base = {
    jobId: "repair-saving",
    activeRepairJobId: "repair-saving",
    jobStatus: "completed",
    expectedContractHash: "contract",
    currentContractHash: "contract",
    expectedResultHash: "result",
    currentResultHash: "result",
    mergedJobIds: new Set(),
  };

  assert.equal(decideLateRepairMerge({ ...base, saveStatus: "saving" }).action, "continue_polling");
  assert.equal(decideLateRepairMerge({ ...base, saveStatus: "saved" }).action, "late_patch_available");
  assert.equal(decideLateRepairMerge({ ...base, saveStatus: "review_saved" }).action, "late_patch_available");
  assert.equal(decideLateRepairMerge({ ...base, saveStatus: "save_failed" }).action, "merge");
});

