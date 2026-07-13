import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createEmptyBatchInvocationCounters,
  installBatchInvocationObserver,
  recordBatchInvocation,
  summarizeBatchInvocations,
} = require("../lib/batch-generation-invocation-ledger.ts");
const {
  assertBatchBenchmarkInvariants,
  createBatchBenchmarkReport,
  summarizeNumericSamples,
} = require("../lib/batch-generation-metrics.ts");

function event(overrides = {}) {
  return {
    eventId: "event-1",
    batchId: "fixture-batch",
    segmentIndexes: [1, 2],
    kind: "render_pack",
    phase: "executing",
    jobId: "render-job-1",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

test("invocation observer is no-op by default and uninstall stops observation", () => {
  assert.doesNotThrow(() => recordBatchInvocation(event()));
  const observed = [];
  const uninstall = installBatchInvocationObserver((value) => observed.push(value));

  recordBatchInvocation(event({ eventId: "observed-1" }));
  uninstall();
  recordBatchInvocation(event({ eventId: "ignored-after-uninstall" }));

  assert.deepEqual(observed.map((value) => value.eventId), ["observed-1"]);
});

test("summary counts executing as the model-call phase and ignores claimed in counters", () => {
  const events = [
    event({ eventId: "planned", phase: "planned" }),
    event({ eventId: "created", phase: "created" }),
    event({ eventId: "claimed", phase: "claimed" }),
    event({ eventId: "executing", phase: "executing" }),
    event({ eventId: "completed", phase: "completed" }),
    event({ eventId: "judge", kind: "coverage_judge", phase: "failed" }),
  ];
  const counters = summarizeBatchInvocations(events);

  assert.deepEqual(counters.render_pack, {
    planned: 1,
    created: 1,
    executing: 1,
    completed: 1,
    failed: 0,
  });
  assert.equal(counters.coverage_judge.failed, 1);
  assert.equal(counters.coverage_judge.executing, 0);
  assert.deepEqual(createEmptyBatchInvocationCounters().single_generation, {
    planned: 0,
    created: 0,
    executing: 0,
    completed: 0,
    failed: 0,
  });
});

test("benchmark report follows the frozen schema and rejects model calls or quality regressions", () => {
  const report = createBatchBenchmarkReport({
    gitCommit: "697e2c9aa77d009b2ac5b0f240e0ffa49292e005",
    branch: "task-quality-pipeline-fix",
    nodeVersion: process.version,
    platform: process.platform,
    fixtureId: "observed-20-segment",
    fixtureHash: "a".repeat(64),
    iterations: 400,
    warmups: 30,
    timingsMs: {
      full_local_pipeline_total: summarizeNumericSamples([1, 2, 3, 4, 5]),
    },
    payloadBytes: {
      statusDto: { p50: 100, p95: 120, max: 120 },
    },
    invocationCounters: createEmptyBatchInvocationCounters(),
    quality: {
      accepted: 20,
      blocked: 0,
      needsReview: 0,
      scores: Array.from({ length: 20 }, () => 100),
      promptLengths: Array.from({ length: 20 }, () => 4200),
      shotCounts: { "4": 20 },
      missingRequiredFields: 0,
      changedUnmatchedPaths: 0,
    },
    generatedAt: "2026-07-13T00:00:00.000Z",
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.order, "alternating-baseline-task");
  assert.equal(report.quality.promptLengths.min, 4200);
  assert.doesNotThrow(() => assertBatchBenchmarkInvariants(report));

  const regressed = structuredClone(report);
  regressed.invocationCounters.path_repair.executing = 1;
  assert.throws(() => assertBatchBenchmarkInvariants(regressed), /model-backed invocation/i);

  const shortPrompt = structuredClone(report);
  shortPrompt.quality.promptLengths.min = 899;
  assert.throws(() => assertBatchBenchmarkInvariants(shortPrompt), /900/);
});
