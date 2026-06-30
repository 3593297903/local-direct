import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("admin module exposes project, usage, and generation log management", () => {
  const mod = readFileSync("apps/api/src/modules/admin/admin.module.ts", "utf8");
  assert.match(mod, /AdminProjectsController/);
  assert.match(mod, /AdminProjectsService/);
  assert.match(mod, /AdminUsageController/);
  assert.match(mod, /AdminUsageService/);
  assert.match(mod, /AdminLogsController/);
  assert.match(mod, /AdminLogsService/);

  for (const file of [
    "apps/api/src/modules/admin/admin-projects.controller.ts",
    "apps/api/src/modules/admin/admin-projects.service.ts",
    "apps/api/src/modules/admin/admin-usage.controller.ts",
    "apps/api/src/modules/admin/admin-usage.service.ts",
    "apps/api/src/modules/admin/admin-logs.controller.ts",
    "apps/api/src/modules/admin/admin-logs.service.ts",
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }
});

test("admin APIs are guarded and support project, usage, and log queries", () => {
  const projectsController = readFileSync("apps/api/src/modules/admin/admin-projects.controller.ts", "utf8");
  assert.match(projectsController, /@Controller\("admin\/projects"\)/);
  assert.match(projectsController, /@UseGuards\(AdminGuard\)/);
  assert.match(projectsController, /@Get\(\)/);
  assert.match(projectsController, /@Get\(":id"\)/);
  assert.match(projectsController, /@Delete\(":id"\)/);

  const usageController = readFileSync("apps/api/src/modules/admin/admin-usage.controller.ts", "utf8");
  assert.match(usageController, /@Controller\("admin\/usage"\)/);
  assert.match(usageController, /@UseGuards\(AdminGuard\)/);
  assert.match(usageController, /@Get\("summary"\)/);
  assert.match(usageController, /@Get\("events"\)/);

  const logsController = readFileSync("apps/api/src/modules/admin/admin-logs.controller.ts", "utf8");
  assert.match(logsController, /@Controller\("admin\/logs"\)/);
  assert.match(logsController, /@UseGuards\(AdminGuard\)/);
  assert.match(logsController, /@Get\(\)/);
});

test("Next admin proxy and pages expose project, usage, and log management", () => {
  const proxy = readFileSync("lib/nest-admin-proxy.ts", "utf8");
  assert.match(proxy, /proxyAdminProjectsList/);
  assert.match(proxy, /proxyAdminProjectDelete/);
  assert.match(proxy, /proxyAdminUsageSummary/);
  assert.match(proxy, /proxyAdminUsageEvents/);
  assert.match(proxy, /proxyAdminLogsList/);

  for (const file of [
    "app/api/admin/projects/route.ts",
    "app/api/admin/projects/[id]/route.ts",
    "app/api/admin/usage/summary/route.ts",
    "app/api/admin/usage/events/route.ts",
    "app/api/admin/logs/route.ts",
    "app/admin/projects/page.tsx",
    "app/admin/usage/page.tsx",
    "app/admin/logs/page.tsx",
  ]) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }

  const shell = readFileSync("components/AdminShell.tsx", "utf8");
  assert.match(shell, /\/admin\/projects/);
  assert.match(shell, /\/admin\/usage/);
  assert.match(shell, /\/admin\/logs/);
  assert.doesNotMatch(shell, /待开发/);
});

test("analysis route consumes usage and records generation jobs", () => {
  const route = readFileSync("app/api/analyze/route.ts", "utf8");
  assert.match(route, /consumeAnalyzeUsageFromNest/);
  assert.match(route, /recordAnalyzeJobToNest/);
  assert.match(route, /usageMeta/);

  assert.equal(existsSync("lib/nest-usage-proxy.ts"), true);
  const proxy = readFileSync("lib/nest-usage-proxy.ts", "utf8");
  assert.match(proxy, /\/usage\/analyze/);
  assert.match(proxy, /\/jobs\/analyze-log/);

  const usageModule = readFileSync("apps/api/src/modules/usage/usage.module.ts", "utf8");
  const jobsModule = readFileSync("apps/api/src/modules/jobs/jobs.module.ts", "utf8");
  assert.match(usageModule, /AuthModule/);
  assert.match(jobsModule, /AuthModule/);
});
