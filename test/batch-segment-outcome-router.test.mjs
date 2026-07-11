import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const { routeBatchSegmentOutcome } = require("../lib/batch-segment-outcome-router.ts");

function finding(code, path, slotId) {
  return {
    severity: "blocking",
    code,
    message: code,
    path,
    slotId,
  };
}

function gate(...blockingFindings) {
  return {
    score: 0,
    findings: blockingFindings,
    blockingFindings,
    patchableFindings: [],
    warningFindings: [],
    riskFindings: [],
  };
}

test("mixed quality and ambiguous findings repair only the quality path", () => {
  const route = routeBatchSegmentOutcome({
    gate: gate(
      finding("field_below_hard_minimum", "storyboard[1].sound"),
      finding("ambiguous_required_event_slot", "storyboard[2].videoPrompt", "cold_marriage"),
    ),
    hasUsableResult: true,
    coverageStage: "judge-active",
  });
  assert.equal(route.action, "request_quality_patch");
  assert.deepEqual(route.repairFindings.map((item) => item.path), ["storyboard[1].sound"]);
  assert.deepEqual(route.ambiguousFindings.map((item) => item.slotId), ["cold_marriage"]);
  assert.equal(route.repairFindings.some((item) => item.code === "ambiguous_required_event_slot"), false);
});

test("ambiguous event routes to Judge only when the stage permits it", () => {
  const ambiguous = gate(finding("ambiguous_required_event_slot", "storyboard[0].videoPrompt", "recognition"));
  assert.equal(routeBatchSegmentOutcome({ gate: ambiguous, hasUsableResult: true, coverageStage: "local" }).action, "needs_review");
  assert.equal(routeBatchSegmentOutcome({ gate: ambiguous, hasUsableResult: true, coverageStage: "judge-shadow" }).action, "enqueue_judge_shadow");
  assert.equal(routeBatchSegmentOutcome({ gate: ambiguous, hasUsableResult: true, coverageStage: "judge-active" }).action, "enqueue_judge");
});

test("confirmed event can be patched only in patch-active", () => {
  const missing = gate(finding("missing_required_event_slot", "storyboard[0].videoPrompt", "cold_marriage"));
  const review = routeBatchSegmentOutcome({ gate: missing, hasUsableResult: true, coverageStage: "judge-active" });
  const patch = routeBatchSegmentOutcome({ gate: missing, hasUsableResult: true, coverageStage: "patch-active" });
  assert.equal(review.action, "needs_review");
  assert.equal(patch.action, "request_event_patch");
  assert.deepEqual(patch.repairFindings.map((item) => item.slotId), ["cold_marriage"]);
});

test("missing result and structural failure regenerate instead of entering path patch", () => {
  const missingResult = routeBatchSegmentOutcome({ gate: gate(), hasUsableResult: false, coverageStage: "patch-active" });
  const structural = routeBatchSegmentOutcome({
    gate: gate(finding("shot_count_mismatch")),
    hasUsableResult: true,
    coverageStage: "patch-active",
  });
  assert.equal(missingResult.action, "regenerate_segment");
  assert.equal(structural.action, "regenerate_segment");
  assert.deepEqual(structural.repairFindings, []);
});
