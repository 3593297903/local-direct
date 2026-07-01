import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Projects page can generate and regenerate storyboard images for saved episodes", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");
  const route = readFileSync("app/api/storyboard-image/jobs/route.ts", "utf8");
  const queue = readFileSync("lib/storyboard-codex-queue.ts", "utf8");

  assert.match(client, /generateEpisodeStoryboards/);
  assert.match(client, /regenerateShotStoryboard/);
  assert.match(client, /pollProjectStoryboardCodexJob/);
  assert.match(client, /saveProjectStoryboardVisualAssets/);
  assert.match(client, /getEpisodeStoryboardActionLabel/);
  assert.match(client, /variantKey: `shot-\$\{panel\.shotNumber\}-storyboard-primary`/);
  assert.match(client, /reloadSelectedProject\(project\.id,/);

  for (const field of ["composition", "lighting", "sound", "dialogue", "shotPurpose"]) {
    assert.match(route, new RegExp(`${field}: z\\.string\\(\\)\\.optional\\(\\)`));
    assert.match(queue, new RegExp(`${field}\\?: string`));
    assert.match(queue, new RegExp(`\\$\\{shot\\.${field}`));
  }
});
