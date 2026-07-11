import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  collectContiguousBatchSaveIndexes,
  resolveBatchGenerationPhase,
  summarizeBatchSegmentProgress,
} = require("../lib/batch-segment-progress.ts");

test("a reviewable result remains saveable and does not block later cached segments", () => {
  const indexes = collectContiguousBatchSaveIndexes({
    startIndex: 1,
    segmentCount: 4,
    renderedIndexes: new Set([1, 2, 3]),
    queuedIndexes: new Set(),
    savedIndexes: new Set(),
  });

  assert.deepEqual(indexes, [1, 2, 3]);
});

test("save scheduling preserves project version order when an earlier result is not ready", () => {
  const indexes = collectContiguousBatchSaveIndexes({
    startIndex: 1,
    segmentCount: 4,
    renderedIndexes: new Set([2, 3]),
    queuedIndexes: new Set(),
    savedIndexes: new Set(),
  });

  assert.deepEqual(indexes, []);
});

test("review-saved segments count as persisted while the batch finishes in needs-review state", () => {
  const summary = summarizeBatchSegmentProgress([
    { index: 1, status: "review_saved" },
    { index: 2, status: "saved" },
    { index: 3, status: "saved" },
  ], 3);

  assert.equal(summary.savedCount, 3);
  assert.equal(summary.needsReviewCount, 1);
  assert.equal(summary.isSettled, true);
  assert.equal(summary.terminalPhase, "needs_review");
});

test("pending or active segments keep a batch non-terminal", () => {
  const summary = summarizeBatchSegmentProgress([
    { index: 1, status: "review_saved" },
    { index: 2, status: "running" },
    { index: 3, status: "pending" },
  ], 3);

  assert.equal(summary.savedCount, 1);
  assert.equal(summary.isSettled, false);
  assert.equal(summary.terminalPhase, null);
});

test("one needs-review segment does not stop a batch while other segments are still active", () => {
  const summary = summarizeBatchSegmentProgress([
    { index: 1, status: "needs_review" },
    { index: 2, status: "running" },
    { index: 3, status: "pending" },
  ], 3);

  assert.equal(resolveBatchGenerationPhase("needs_review", summary), "rendering");
});

test("needs-review becomes terminal only after every segment is persisted", () => {
  const summary = summarizeBatchSegmentProgress([
    { index: 1, status: "review_saved" },
    { index: 2, status: "saved" },
  ], 2);

  assert.equal(resolveBatchGenerationPhase("saving", summary), "needs_review");
});
