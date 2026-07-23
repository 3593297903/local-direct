import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { readSegmentBatchCache, writeSegmentBatchCache } = require("../lib/segment-batch-cache.ts");

test("server batch cache stores complete segment results outside localStorage", async () => {
  const rootDir = path.join(os.tmpdir(), `segment-batch-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const payload = {
      schemaVersion: 1,
      batchId: "batch-1",
      projectId: null,
      sourceHash: "src-1",
      contractHash: "contract-1",
      resolvedSegmentCount: 30,
      updatedAt: new Date().toISOString(),
      phase: "needs_review",
      segmentStates: [
        { index: 1, status: "review_saved", message: "已保存，待检查" },
        { index: 2, status: "saved", message: "已保存" },
      ],
      qualityReports: [],
      segments: [{ episodeIndex: 7, result: { title: "第7段" }, promptText: "完整提示词", sourceText: "原文" }],
      needsReviewSegments: [],
    };
    await writeSegmentBatchCache(payload, { rootDir });
    assert.deepEqual(await readSegmentBatchCache("batch-1", { rootDir }), payload);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("server batch cache lease prevents a second active generator from overwriting progress", async () => {
  const rootDir = path.join(os.tmpdir(), `segment-batch-cache-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const base = {
    schemaVersion: 1,
    batchId: "batch-lease",
    projectId: null,
    sourceHash: "src",
    contractHash: "contract",
    resolvedSegmentCount: 2,
    updatedAt: new Date().toISOString(),
    qualityReports: [],
    segments: [],
    needsReviewSegments: [],
    leaseOwnerId: "owner-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  try {
    await writeSegmentBatchCache(base, { rootDir });
    await assert.rejects(
      () => writeSegmentBatchCache({ ...base, leaseOwnerId: "owner-b" }, { rootDir }),
      /leased by another active generator/i,
    );
    const renewed = await writeSegmentBatchCache({ ...base, updatedAt: new Date().toISOString() }, { rootDir });
    assert.equal(renewed.leaseOwnerId, "owner-a");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
