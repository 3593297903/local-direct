import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const routeFiles = [
  "app/api/visual-asset-image/jobs/route.ts",
  "app/api/visual-asset-image/jobs/[jobId]/route.ts",
  "app/api/visual-asset-image/jobs/claim/route.ts",
  "app/api/visual-asset-image/jobs/[jobId]/complete/route.ts",
  "app/api/visual-asset-image/jobs/[jobId]/fail/route.ts",
];

test("visual asset Codex image job routes exist and call the queue", () => {
  for (const file of routeFiles) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const createRoute = readFileSync(routeFiles[0], "utf8");
  const getRoute = readFileSync(routeFiles[1], "utf8");
  const claimRoute = readFileSync(routeFiles[2], "utf8");
  const completeRoute = readFileSync(routeFiles[3], "utf8");
  const failRoute = readFileSync(routeFiles[4], "utf8");

  assert.match(createRoute, /createVisualAssetCodexJob/);
  assert.match(createRoute, /entityType/);
  assert.match(getRoute, /getVisualAssetCodexJob/);
  assert.match(claimRoute, /claimNextVisualAssetCodexTask/);
  assert.match(completeRoute, /completeVisualAssetCodexTask/);
  assert.match(failRoute, /failVisualAssetCodexTask/);
});

test("visual asset Codex worker is exposed as a package script", () => {
  const pkg = readFileSync("package.json", "utf8");
  const worker = readFileSync("scripts/visual-asset-codex-worker.mjs", "utf8");

  assert.match(pkg, /visual-asset:codex-worker/);
  assert.match(worker, /VISUAL_ASSET_CODEX_CONCURRENCY/);
  assert.match(worker, /\/api\/visual-asset-image\/jobs\/claim/);
  assert.match(worker, /\/api\/visual-asset-image\/jobs\/.*\/complete/);
  assert.match(worker, /\$imagegen/);
});
