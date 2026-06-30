import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("sidebar exposes a My Projects route", () => {
  const sidebar = readFileSync("components/Sidebar.tsx", "utf8");

  assert.match(sidebar, /href: "\/projects"/);
  assert.match(sidebar, /name: "我的项目"/);
});

test("projects page mounts account navigation and handles detail failures clearly", () => {
  const page = readFileSync("app/projects/page.tsx", "utf8");
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(page, /UserAccountNav/);
  assert.match(client, /projectDetailError/);
  assert.match(client, /reloadSelectedProject/);
  assert.match(client, /overflow-x-auto/);
  assert.match(proxy, /Project detail endpoint is unavailable/);
});

test("Nest project service returns project detail with versions, shots, and storyboard image url", () => {
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");

  assert.match(controller, /@Get\(":projectId"\)/);
  assert.match(controller, /getProject\(request\.user\.id, projectId\)/);
  assert.match(service, /async getProject\(userId: string, projectId: string\)/);
  assert.match(service, /versions:\s*\{/);
  assert.match(service, /storyboardImageUrl/);
  assert.match(service, /shots:\s*\{/);
});

test("Next projects API proxies project detail requests", () => {
  const helper = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const routePath = "app/api/projects/[projectId]/route.ts";

  assert.equal(existsSync(routePath), true, `${routePath} should exist`);
  assert.match(helper, /proxyNestProjectGet/);
  assert.match(helper, /\/projects\/\$\{projectId\}/);
  assert.match(readFileSync(routePath, "utf8"), /proxyNestProjectGet\(request, params\.projectId\)/);
});

test("projects page shows saved prompt history and supports resume editing", () => {
  const pagePath = "app/projects/page.tsx";
  const clientPath = "components/ProjectsClient.tsx";

  assert.equal(existsSync(pagePath), true, `${pagePath} should exist`);
  assert.equal(existsSync(clientPath), true, `${clientPath} should exist`);

  const page = readFileSync(pagePath, "utf8");
  const client = readFileSync(clientPath, "utf8");

  assert.match(page, /<Sidebar \/>/);
  assert.match(page, /<ProjectsClient \/>/);
  assert.match(client, /我的项目/);
  assert.match(client, /第 \{version\.versionNumber\} 集/);
  assert.match(client, /storyboardImageUrl/);
  assert.match(client, /vd_resume_script/);
  assert.match(client, /vd_resume_version_id/);
  assert.match(client, /下载 DOCX/);
});
