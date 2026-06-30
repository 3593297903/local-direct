import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("projects support user-owned deletion from Nest through the Next proxy", () => {
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const route = readFileSync("app/api/projects/[projectId]/route.ts", "utf8");

  assert.match(controller, /@Delete\(":projectId"\)/);
  assert.match(controller, /deleteProject\(request\.user\.id, projectId\)/);
  assert.match(service, /async deleteProject\(userId: string, projectId: string\)/);
  assert.match(service, /deleteMany\(\{\s*where: \{ id: projectId, userId \}/s);
  assert.match(proxy, /proxyNestProjectDelete/);
  assert.match(proxy, /method: "DELETE"/);
  assert.match(proxy, /deleteLocalProjectStoryboardImages/);
  assert.match(proxy, /"project-assets", "storyboards"/);
  assert.match(proxy, /Project delete endpoint is unavailable/);
  assert.match(route, /export async function DELETE/);
});

test("projects page has delete selection mode and no project status badge", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /deleteMode/);
  assert.match(client, /checkedProjectIds/);
  assert.match(client, /deleteCheckedProjects/);
  assert.match(client, /fetch\(`\/api\/projects\/\$\{projectId\}`,[\s\S]*method: "DELETE"/);
  assert.doesNotMatch(client, /getStatusLabel\(item\.status\)/);
});
