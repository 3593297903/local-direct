import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("video prompt render pack API exposes create, poll, claim, complete, and fail routes", () => {
  const routes = [
    "app/api/video-prompt-packs/jobs/route.ts",
    "app/api/video-prompt-packs/jobs/[jobId]/route.ts",
    "app/api/video-prompt-packs/jobs/claim/route.ts",
    "app/api/video-prompt-packs/jobs/[jobId]/complete/route.ts",
    "app/api/video-prompt-packs/jobs/[jobId]/fail/route.ts",
  ];

  for (const route of routes) {
    assert.equal(existsSync(route), true, `${route} should exist`);
  }

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /createVideoPromptPackCodexJob/);
  assert.match(createRoute, /segments/);
  assert.match(createRoute, /episodeIndex/);
  assert.match(createRoute, /renderInputScript/);
  assert.match(createRoute, /batchId/);
  assert.match(createRoute, /operationToken/);
  assert.match(createRoute, /idempotencyKey/);
  assert.match(createRoute, /\.strict\(\)/);
  assert.match(createRoute, /assertCodexFinalizationV2CreateEnabled/);
  assert.match(createRoute, /FINALIZATION_V2_CREATE_PAUSED/);
  assert.match(createRoute, /status:\s*503/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /claimNextVideoPromptPackCodexJob/);
  assert.match(claimRoute, /VIDEO_PROMPT_PACK_CODEX_WORKER_TOKEN/);
  assert.match(
    claimRoute,
    /VIDEO_PROMPT_PACK_CODEX_ORDER\s*===\s*"newest"\s*\?\s*"newest"\s*:\s*"oldest"/,
    "render pack worker should claim oldest jobs unless newest is explicitly requested",
  );

  const completeRoute = readFileSync(routes[3], "utf8");
  assert.match(completeRoute, /completeVideoPromptPackCodexJob/);

  const failRoute = readFileSync(routes[4], "utf8");
  assert.match(failRoute, /failVideoPromptPackCodexJob/);
});

test("video prompt render pack worker runs bounded concurrent pack tasks", () => {
  const worker = readFileSync("scripts/video-prompt-pack-codex-worker.mjs", "utf8");

  assert.match(worker, /VIDEO_PROMPT_PACK_CODEX_CONCURRENCY/);
  assert.match(worker, /positiveInteger\(process\.env\.VIDEO_PROMPT_PACK_CODEX_CONCURRENCY,\s*4\)/);
  assert.match(worker, /activeTasks/);
  assert.match(worker, /Promise\.race\(activeTasks\)/);
  assert.match(worker, /\/api\/video-prompt-packs\/jobs\/claim/);
  assert.match(worker, /Do not use 同上/);
  assert.match(worker, /child\.on\("close"/);
  assert.doesNotMatch(worker, /child\.on\("exit"/);
  assert.match(worker, /finalizeVideoPromptPackCodexJobFiles/);
  assert.match(worker, /resultRef/);
});
