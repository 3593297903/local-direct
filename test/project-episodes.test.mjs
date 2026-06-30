import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("project save can overwrite the selected episode instead of always creating a new one", () => {
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(dto, /versionId\?: string/);
  assert.match(proxy, /versionId: payload\.versionId/);
  assert.match(service, /input\.versionId/);
  assert.match(service, /projectVersion\.update/);
  assert.match(service, /deleteMany\(\{\s*where:\s*\{\s*versionId:\s*input\.versionId/s);

  assert.match(projects, /vd_resume_version_id/);
  assert.match(dashboard, /vd_resume_version_id/);
  assert.match(dashboard, /versionId,\s*originalScript/s);
});

test("project versions are presented and downloaded as episodes", () => {
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(projects, /第\s*\{version\.versionNumber\}\s*集/);
  assert.doesNotMatch(projects, /版本 v\{version\.versionNumber\}/);
  assert.match(projects, /第\$\{selectedVersion\.versionNumber\}集/);
});

test("users can delete a single episode and remaining episodes are compacted", () => {
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const route = readFileSync("app/api/projects/[projectId]/route.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(controller, /@Delete\(":projectId\/versions\/:versionId"\)/);
  assert.match(controller, /deleteProjectVersion\(request\.user\.id, projectId, versionId\)/);
  assert.match(service, /async deleteProjectVersion\(userId: string, projectId: string, versionId: string\)/);
  assert.match(service, /versionNumber:\s*\{\s*decrement:\s*1\s*\}/);

  assert.match(route, /proxyNestProjectVersionDelete\(request, params\.projectId, versionId\)/);
  assert.match(proxy, /export async function proxyNestProjectVersionDelete/);
  assert.match(projects, /deleteSelectedEpisode/);
  assert.match(projects, /\/api\/projects\/\$\{project\.id\}\?versionId=\$\{selectedVersion\.id\}/);
});

test("new episode keeps the current project but clears the selected episode id", () => {
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(projects, /startNewEpisode/);
  assert.match(projects, /vd_resume_project_id/);
  assert.match(projects, /removeItem\("vd_resume_version_id"\)/);
  assert.match(projects, /setItem\("vd_new_episode",\s*"1"\)/);
  assert.match(dashboard, /resumeProject && !resumeScript/);
  assert.match(dashboard, /newEpisodeMode === "1"/);
  assert.match(dashboard, /setResumeProjectId\(resumeProject \|\| ""\)/);
  assert.match(dashboard, /setResumeVersionId\(""\)/);
  assert.match(dashboard, /creatingNewEpisodeRef/);
  assert.match(dashboard, /getActiveResumeVersionId/);
  assert.match(dashboard, /creatingNewEpisodeRef\.current \? undefined : resumeVersionId \|\| undefined/);
});

test("top-level new generation starts a fresh project instead of a new episode", () => {
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(projects, /function startNewProject\(\)/);
  assert.match(projects, /onClick=\{startNewProject\}/);

  const clearContextBody = projects.match(/function clearDashboardProjectContext\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(clearContextBody, "expected clearDashboardProjectContext body");
  assert.match(clearContextBody, /removeItem\("vd_resume_script"\)/);
  assert.match(clearContextBody, /removeItem\("vd_resume_project_id"\)/);
  assert.match(clearContextBody, /removeItem\("vd_resume_version_id"\)/);
  assert.match(clearContextBody, /removeItem\("vd_new_episode"\)/);

  const newProjectBody = projects.match(/function startNewProject\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(newProjectBody, "expected startNewProject body");
  assert.match(newProjectBody, /clearDashboardProjectContext\(\)/);
  assert.doesNotMatch(newProjectBody, /setItem\("vd_resume_project_id"/);
  assert.doesNotMatch(newProjectBody, /setItem\("vd_new_episode"/);
});

test("saving a later episode does not overwrite the series project title", () => {
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");

  const existingProjectLookup = service.match(
    /input\.projectId\s*\?\s*await prisma\.project\.findFirst\(\{[\s\S]*?\}\)\s*:\s*await prisma\.project\.create/,
  )?.[0] || "";

  assert.ok(existingProjectLookup, "expected existing project lookup branch");
  assert.doesNotMatch(existingProjectLookup, /title:\s*input\.title/);
  assert.doesNotMatch(existingProjectLookup, /originalScript:\s*input\.originalScript/);
  assert.match(service, /projectVersion\.(update|create)\(\{[\s\S]*title:\s*input\.title/);
});
