import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Prisma project history stores versions and optional storyboard image references", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /model ProjectVersion \{/);
  assert.match(schema, /versions\s+ProjectVersion\[\]/);
  assert.match(schema, /versionId\s+String\s+@db\.Uuid/);
  assert.match(schema, /storyboardImageUrl\s+String\?/);
  assert.match(schema, /fullVideoPrompt\s+String\?/);
  assert.match(schema, /@@unique\(\[projectId, versionNumber\]\)/);
  assert.match(schema, /@@unique\(\[versionId, shotNumber\]\)/);
});

test("Nest project save returns project and version ids for later storyboard image save", () => {
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");

  assert.match(dto, /projectId\?: string/);
  assert.match(dto, /storyboardImageUrl\?: string/);
  assert.match(dto, /fullVideoPrompt\?: string/);
  assert.match(service, /prisma\.projectVersion\.create/);
  assert.match(service, /versionNumber/);
  assert.match(service, /fullVideoPrompt: input\.fullVideoPrompt/);
  assert.match(service, /return \{ saved: true, projectId: result\.project\.id, versionId: result\.version\.id/);
  assert.match(controller, /saveStoryboardImage/);
});

test("dashboard saves storyboard image only after it exists", () => {
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(dashboard, /type ProjectSaveState/);
  assert.match(dashboard, /setProjectSave\(save\)/);
  assert.match(dashboard, /saveStoryboardImageReference/);
  assert.match(dashboard, /storyboardImageUrl,\s*storyboardImagePrompt/s);
});

test("Next project image proxy persists data URL to a public project asset instead of database", () => {
  const route = readFileSync("app/api/projects/storyboard-image/route.ts", "utf8");

  assert.match(route, /public", "project-assets", "storyboards"/);
  assert.match(route, /writeFile/);
  assert.match(route, /storyboardImageUrl/);
  assert.doesNotMatch(route, /body:\s*JSON\.stringify\(body\)/);
});
