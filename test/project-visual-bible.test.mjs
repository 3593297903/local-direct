import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("Prisma schema models project-level visual bible entities and shot references", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /enum\s+VisualEntityType/);
  assert.match(schema, /CHARACTER/);
  assert.match(schema, /SCENE/);
  assert.match(schema, /PROP/);
  assert.match(schema, /enum\s+VisualEntityStatus/);
  assert.match(schema, /LOCKED/);
  assert.match(schema, /enum\s+ShotVisualReferenceRole/);
  assert.match(schema, /model\s+ProjectVisualEntity/);
  assert.match(schema, /canonicalPrompt\s+String\?/);
  assert.match(schema, /visualLock\s+String\?/);
  assert.match(schema, /negativeLock\s+String\?/);
  assert.match(schema, /primaryAssetId\s+String\?/);
  assert.match(schema, /model\s+ShotVisualReference/);
  assert.match(schema, /entityId\s+String/);
  assert.match(schema, /role\s+ShotVisualReferenceRole/);
  assert.match(schema, /VisualAsset[\s\S]*entityId\s+String\?/);
  assert.match(schema, /VisualAsset[\s\S]*variantKey\s+String\?/);
  assert.match(schema, /VisualAsset[\s\S]*isPrimary\s+Boolean/);
  assert.match(schema, /VisualAsset[\s\S]*locked\s+Boolean/);
  assert.match(schema, /Project[\s\S]*visualEntities\s+ProjectVisualEntity\[\]/);
  assert.match(schema, /ProjectVersion[\s\S]*shotVisualReferences\s+ShotVisualReference\[\]/);

  assert.ok(
    existsSync("prisma/migrations/20260630050000_project_visual_bible/migration.sql"),
    "expected a Prisma migration for project visual bible tables",
  );
});

test("Project API exposes visual bible persistence and returns it with project detail", () => {
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(dto, /SaveProjectVisualEntitiesDto/);
  assert.match(dto, /SaveShotVisualReferencesDto/);
  assert.match(controller, /:projectId\/visual-entities/);
  assert.match(controller, /saveProjectVisualEntities/);
  assert.match(controller, /versions\/:versionId\/visual-references/);
  assert.match(controller, /saveShotVisualReferences/);
  assert.match(service, /upsertProjectVisualEntities/);
  assert.match(service, /upsertShotVisualReferences/);
  assert.match(service, /visualEntities:/);
  assert.match(service, /shotVisualReferences:/);
  assert.match(proxy, /saveProjectVisualEntitiesToNest/);
  assert.match(proxy, /saveShotVisualReferencesToNest/);

  assert.ok(existsSync("app/api/projects/visual-entities/route.ts"));
  assert.ok(existsSync("app/api/projects/visual-references/route.ts"));
});

test("Project save derives candidate visual bible entities from generation memory", () => {
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");

  assert.match(service, /function deriveProjectVisualEntities/);
  assert.match(service, /narrativeMemory\.characters/);
  assert.match(service, /memoryJson\.scenes/);
  assert.match(service, /memoryJson\.visualFocus/);
  assert.match(service, /VisualEntityStatus\.CANDIDATE/);
  assert.match(service, /await upsertProjectVisualEntities\(prisma/);
});

test("Projects page shows the project visual bible in the asset library", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /type ProjectVisualEntity/);
  assert.match(client, /visualEntities\?: ProjectVisualEntity\[\]/);
  assert.match(client, /type ShotVisualReference/);
  assert.match(client, /shotVisualReferences\?: ShotVisualReference\[\]/);
  assert.match(client, /项目视觉圣经/);
  assert.match(client, /角色/);
  assert.match(client, /场景/);
  assert.match(client, /道具/);
  assert.match(client, /已锁定/);
  assert.match(client, /projectAssetLibrarySections/);
  assert.match(client, /getEntityVisualAssets/);
  assert.match(client, /projects-asset-card/);
});

test("Projects page separates episode content from the project asset library", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /projectDetailView/);
  assert.match(client, /projects-project-stepper/);
  assert.match(client, /分段/);
  assert.match(client, /资产库/);
  assert.match(client, /分段视频/);
  assert.match(client, /setProjectDetailView\("episodes"\)/);
  assert.match(client, /setProjectDetailView\("assets"\)/);
  assert.match(client, /projectAssetLibrarySections/);
  assert.match(client, /activeAssetType/);
  assert.match(client, /getEntityVisualAssets/);
  assert.match(client, /projects-asset-grid/);
});
