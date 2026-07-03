import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Projects page can generate and save visual bible asset images", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /type VisualAssetCodexJob/);
  assert.match(client, /createVisualAssetCodexJob/);
  assert.match(client, /pollVisualAssetCodexJob/);
  assert.match(client, /saveGeneratedVisualAsset/);
  assert.match(client, /\/api\/visual-asset-image\/jobs/);
  assert.match(client, /\/api\/projects\/visual-assets/);
  assert.match(client, /visualAssetGeneratingEntityId/);
  assert.match(client, /generateProjectVisualEntityAsset/);
  assert.match(client, /CHARACTER_TURNAROUND/);
  assert.match(client, /SCENE_KEYART/);
  assert.match(client, /PROP_SHEET/);
});

test("Project asset cards expose generate and regenerate actions", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /生成资产图/);
  assert.match(client, /重新生成/);
  assert.match(client, /生成中/);
  assert.match(client, /activeAssetLibrarySection\.assetLabel/);
  assert.match(client, /onClick=\{\(\) => generateProjectVisualEntityAsset\(entity\)\}/);
});
