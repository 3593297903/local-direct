import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("season pack Codex job API exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/season-pack/jobs/route.ts",
    "app/api/season-pack/jobs/[jobId]/route.ts",
    "app/api/season-pack/jobs/claim/route.ts",
    "app/api/season-pack/jobs/[jobId]/complete/route.ts",
    "app/api/season-pack/jobs/[jobId]/fail/route.ts",
  ];

  for (const route of routes) {
    assert.equal(existsSync(route), true, `${route} should exist`);
  }

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /createSeasonPackCodexJob/);
  assert.match(createRoute, /fetchDirectorContextFromNest/);
  assert.match(createRoute, /RequestSchema/);
  assert.match(createRoute, /episodeCount/);
  assert.match(createRoute, /segmentCountMode/);
  assert.match(createRoute, /auto/);
  assert.match(createRoute, /projectMemory/);

  const pollRoute = readFileSync(routes[1], "utf8");
  assert.match(pollRoute, /getSeasonPackCodexJob/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /claimNextSeasonPackCodexJob/);
  assert.match(claimRoute, /SEASON_PACK_CODEX_WORKER_TOKEN/);

  const completeRoute = readFileSync(routes[3], "utf8");
  assert.match(completeRoute, /completeSeasonPackCodexJob/);

  const failRoute = readFileSync(routes[4], "utf8");
  assert.match(failRoute, /failSeasonPackCodexJob/);
});
