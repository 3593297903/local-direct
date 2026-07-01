import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard creates and polls Codex storyboard image jobs", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(source, /createStoryboardCodexJob/);
  assert.match(source, /pollStoryboardCodexJob/);
  assert.match(source, /\/api\/storyboard-image\/jobs/);
  assert.match(source, /\/api\/storyboard-image\/jobs\/\$\{jobId\}/);
  assert.match(source, /projectSave\.projectId/);
  assert.match(source, /projectSave\.versionId/);
  assert.match(source, /saveStoryboardVisualAssets\(completedJob\)/);
  assert.match(source, /\/api\/projects\/visual-assets/);
  assert.match(source, /SHOT_STORYBOARD/);
  assert.doesNotMatch(source, /completedJob\.sheetUrl\) throw/);
});

test("dashboard requires saved projects and does not fall back to the legacy sheet endpoint", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.doesNotMatch(source, /generateStoryboardImageDirect/);
  assert.doesNotMatch(source, /fetch\("\/api\/storyboard-image",/);
  assert.match(source, /createStoryboardCodexJob\(result\)/);
  assert.match(source, /projectSave\?\.saved/);
});

test("dashboard waits long enough for five local Codex storyboard panels", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(source, /calculateStoryboardCodexTimeoutMs/);
  assert.match(source, /30 \* 60_000/);
  assert.match(source, /job\.panels\.length \* 8 \* 60_000/);
  assert.doesNotMatch(source, /10 \* 60_000/);
});
