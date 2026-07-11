import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  createBatchEventFeatureSnapshot,
  normalizeBatchEventFeatureSnapshot,
} = require("../lib/batch-event-feature-flags.ts");

test("batch event feature flags use conservative rollout defaults", () => {
  const capturedAt = "2026-07-10T00:00:00.000Z";
  const snapshot = createBatchEventFeatureSnapshot({}, capturedAt);
  assert.equal(snapshot.contractV2, true);
  assert.equal(snapshot.coverageSidecar, true);
  assert.equal(snapshot.coverageStage, "shadow");
  assert.equal(snapshot.emergencyStop, false);
  assert.equal(snapshot.localGate, false);
  assert.equal(snapshot.judge, false);
  assert.equal(snapshot.capturedAt, capturedAt);
  assert.ok(snapshot.coveragePolicyVersion);
});

test("batch event feature snapshot is normalized once and does not read later environment changes", () => {
  const snapshot = createBatchEventFeatureSnapshot({
    BATCH_EVENT_CONTRACT_V2: "true",
    BATCH_EVENT_COVERAGE_SIDECAR: "false",
    BATCH_EVENT_COVERAGE_STAGE: "judge-shadow",
    BATCH_EVENT_COVERAGE_POLICY_VERSION: "policy-test",
  }, "2026-07-10T01:00:00.000Z");
  assert.deepEqual(normalizeBatchEventFeatureSnapshot(snapshot), snapshot);
  assert.equal(snapshot.coverageSidecar, false);
  assert.equal(snapshot.coverageStage, "judge-shadow");
  assert.equal(snapshot.localGate, true);
  assert.equal(snapshot.judge, true);
  assert.equal(snapshot.coveragePolicyVersion, "policy-test");
});

test("legacy booleans map to one coverage stage", () => {
  const snapshot = createBatchEventFeatureSnapshot({
    BATCH_EVENT_COVERAGE_LOCAL_GATE: "true",
    BATCH_EVENT_COVERAGE_JUDGE: "true",
  });
  assert.equal(snapshot.coverageStage, "judge-active");
  assert.equal(snapshot.localGate, true);
  assert.equal(snapshot.judge, true);
});

test("emergency stop forces the effective stage to shadow", () => {
  const snapshot = createBatchEventFeatureSnapshot({
    BATCH_EVENT_COVERAGE_STAGE: "patch-active",
    BATCH_EVENT_COVERAGE_EMERGENCY_STOP: "true",
  });
  assert.equal(snapshot.coverageStage, "shadow");
  assert.equal(snapshot.emergencyStop, true);
  assert.equal(snapshot.localGate, false);
  assert.equal(snapshot.judge, false);
});
