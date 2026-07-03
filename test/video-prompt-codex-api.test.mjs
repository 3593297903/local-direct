import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("video prompt Codex job API exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/video-prompt/jobs/route.ts",
    "app/api/video-prompt/jobs/[jobId]/route.ts",
    "app/api/video-prompt/jobs/claim/route.ts",
    "app/api/video-prompt/jobs/[jobId]/complete/route.ts",
    "app/api/video-prompt/jobs/[jobId]/fail/route.ts",
  ];

  for (const route of routes) {
    assert.equal(existsSync(route), true, `${route} should exist`);
  }

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /createVideoPromptCodexJob/);
  assert.match(createRoute, /fetchDirectorContextFromNest/);
  assert.match(createRoute, /RequestSchema/);
  assert.match(createRoute, /script/);
  assert.match(createRoute, /projectId/);
  assert.match(createRoute, /versionId/);
  assert.match(createRoute, /projectMemory/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /claimNextVideoPromptCodexJob/);
  assert.match(claimRoute, /VIDEO_PROMPT_CODEX_WORKER_TOKEN/);

  const completeRoute = readFileSync(routes[3], "utf8");
  assert.match(completeRoute, /completeVideoPromptCodexJob/);

  const failRoute = readFileSync(routes[4], "utf8");
  assert.match(failRoute, /failVideoPromptCodexJob/);
});
