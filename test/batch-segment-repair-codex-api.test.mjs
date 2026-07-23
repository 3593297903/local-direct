import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("batch segment repair exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/batch-segment-repair/jobs/route.ts",
    "app/api/batch-segment-repair/jobs/[jobId]/route.ts",
    "app/api/batch-segment-repair/jobs/claim/route.ts",
    "app/api/batch-segment-repair/jobs/[jobId]/complete/route.ts",
    "app/api/batch-segment-repair/jobs/[jobId]/fail/route.ts",
  ];
  for (const route of routes) assert.equal(existsSync(route), true, `${route} should exist`);
  assert.match(readFileSync(routes[0], "utf8"), /createBatchSegmentRepairCodexJob/);
  assert.match(readFileSync(routes[2], "utf8"), /claimNextBatchSegmentRepairCodexJob/);
  assert.match(readFileSync(routes[3], "utf8"), /completeBatchSegmentRepairCodexJob/);
  assert.match(readFileSync(routes[4], "utf8"), /failBatchSegmentRepairCodexJob/);
});
