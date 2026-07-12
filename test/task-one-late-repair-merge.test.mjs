import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { decideLateRepairMerge } = require("../lib/batch-repair-scheduler.ts");

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

