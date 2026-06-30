import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Prisma schema defines reusable VisualAsset records for shot, character, scene, and prop images", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /enum\s+VisualAssetType/);
  assert.match(schema, /SHOT_STORYBOARD/);
  assert.match(schema, /CHARACTER_TURNAROUND/);
  assert.match(schema, /SCENE_KEYART/);
  assert.match(schema, /PROP_SHEET/);
  assert.match(schema, /model\s+VisualAsset/);
  assert.match(schema, /shotNumber\s+Int\?/);
  assert.match(schema, /imageUrl\s+String\?/);
  assert.match(schema, /ProjectVersion[\s\S]*visualAssets\s+VisualAsset\[\]/);
  assert.match(schema, /StoryboardShot[\s\S]*visualAssets\s+VisualAsset\[\]/);
});

test("Nest projects API exposes visual asset persistence and returns assets in project detail", () => {
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");

  assert.match(dto, /SaveVisualAssetsDto/);
  assert.match(dto, /visualAssets!: SaveVisualAssetDto\[\]/);
  assert.match(controller, /versions\/:versionId\/visual-assets/);
  assert.match(controller, /saveVisualAssets/);
  assert.match(service, /visualAssets:/);
  assert.match(service, /upsertVisualAssets/);
  assert.match(service, /SHOT_STORYBOARD/);
});

test("Next project proxy supports saving visual assets through the authenticated project API", () => {
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const route = readFileSync("app/api/projects/visual-assets/route.ts", "utf8");

  assert.match(proxy, /saveVisualAssetsToNest/);
  assert.match(proxy, /\/visual-assets/);
  assert.match(route, /VisualAssetSchema/);
  assert.match(route, /saveVisualAssetsToNest/);
});

test("Dashboard saves shot storyboard panels as VisualAsset records and renders shot asset sections", () => {
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(dashboard, /生成镜头分镜图/);
  assert.match(dashboard, /saveStoryboardVisualAssets/);
  assert.match(dashboard, /\/api\/projects\/visual-assets/);
  assert.match(dashboard, /SHOT_STORYBOARD/);
  assert.match(dashboard, /镜头资产/);
  assert.doesNotMatch(dashboard, /整张参考分镜图/);
});

test("Projects page shows saved visual assets under each shot", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /type VisualAsset/);
  assert.match(client, /visualAssets\?: VisualAsset\[\]/);
  assert.match(client, /getShotAssets/);
  assert.match(client, /镜头资产/);
  assert.match(client, /SHOT_STORYBOARD/);
});
