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
  assert.match(client, /项目列表/);
  assert.match(client, /第 \{version\.versionNumber\} 段/);
  assert.match(client, /storyboardImageUrl/);
  assert.match(client, /vd_resume_script/);
  assert.match(client, /vd_resume_version_id/);
  assert.match(client, /下载 DOCX/);
});

test("projects page puts global project actions in the project list toolbar", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");
  const styles = readFileSync("app/globals.css", "utf8");

  assert.doesNotMatch(client, /projects-header/);
  assert.match(client, /projects-list-toolbar/);
  assert.match(client, /projects-list-actions/);
  assert.match(client, /projects-list-action-button/);
  assert.match(styles, /\.projects-list-action-button/);
  assert.ok(client.indexOf("项目列表") < client.indexOf("新建生成"));
});

test("projects detail keeps episode selection in a fixed scrollable dock", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");
  const styles = readFileSync("app/globals.css", "utf8");

  assert.match(client, /projects-version-dock/);
  assert.match(client, /projects-version-list/);
  assert.match(client, /projects-version-button/);
  assert.doesNotMatch(client, /selectedStoryboardAssets/);
  assert.match(styles, /\.projects-version-list/);
  assert.match(styles, /max-height:\s*15rem/);
  assert.match(styles, /overflow-y:\s*auto/);
});

test("projects detail layout keeps wide tables and long prompts inside the viewport", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(client, /xl:grid-cols-\[360px_minmax\(0,1fr\)\]/);
  assert.match(client, /projects-detail-panel min-w-0/);
  assert.match(client, /max-w-full overflow-x-auto/);
  assert.match(client, /break-words/);
});

test("projects list uses an internal vertical scroller instead of stretching the page", () => {
  const client = readFileSync("components/ProjectsClient.tsx", "utf8");
  const styles = readFileSync("app/globals.css", "utf8");

  assert.match(client, /projects-list-panel min-w-0/);
  assert.match(client, /projects-list-scroll/);
  assert.match(styles, /\.projects-list-panel\s*\{/);
  assert.match(styles, /max-height:\s*calc\(100vh - 10rem\)/);
  assert.match(styles, /flex-direction:\s*column/);
  assert.match(styles, /\.projects-list-scroll\s*\{/);
  assert.match(styles, /overflow-y:\s*auto/);
  assert.match(styles, /overscroll-behavior:\s*contain/);
});
