import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("storyboard Codex job API exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/storyboard-image/jobs/route.ts",
    "app/api/storyboard-image/jobs/[jobId]/route.ts",
    "app/api/storyboard-image/jobs/claim/route.ts",
    "app/api/storyboard-image/jobs/[jobId]/panels/[panelId]/complete/route.ts",
    "app/api/storyboard-image/jobs/[jobId]/panels/[panelId]/fail/route.ts",
  ];

  for (const route of routes) {
    assert.equal(existsSync(route), true, `${route} should exist`);
  }

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /createStoryboardCodexJob/);
  assert.match(createRoute, /RequestSchema/);
  assert.match(createRoute, /projectId/);
  assert.match(createRoute, /versionId/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /claimNextStoryboardCodexPanel/);
  assert.match(claimRoute, /STORYBOARD_CODEX_WORKER_TOKEN/);

  const completeRoute = readFileSync(routes[3], "utf8");
  assert.match(completeRoute, /completeStoryboardCodexPanel/);

  const failRoute = readFileSync(routes[4], "utf8");
  assert.match(failRoute, /failStoryboardCodexPanel/);
});
