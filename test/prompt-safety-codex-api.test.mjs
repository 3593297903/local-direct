import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("prompt safety Codex job API exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/prompt-safety/jobs/route.ts",
    "app/api/prompt-safety/jobs/[jobId]/route.ts",
    "app/api/prompt-safety/jobs/claim/route.ts",
    "app/api/prompt-safety/jobs/[jobId]/complete/route.ts",
    "app/api/prompt-safety/jobs/[jobId]/fail/route.ts",
  ];

  for (const route of routes) {
    assert.equal(existsSync(route), true, `${route} should exist`);
  }

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /createPromptSafetyCodexJob/);
  assert.match(createRoute, /sourceResult/);
  assert.match(createRoute, /promptText/);
  assert.match(createRoute, /targetModel/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /claimNextPromptSafetyCodexJob/);
  assert.match(claimRoute, /PROMPT_SAFETY_CODEX_WORKER_TOKEN/);

  const completeRoute = readFileSync(routes[3], "utf8");
  assert.match(completeRoute, /completePromptSafetyCodexJob/);

  const failRoute = readFileSync(routes[4], "utf8");
  assert.match(failRoute, /failPromptSafetyCodexJob/);
});
