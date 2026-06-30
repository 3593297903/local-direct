import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const requiredFiles = [
  "apps/api/src/main.ts",
  "apps/api/src/app.module.ts",
  "apps/api/src/prisma/prisma.service.ts",
  "apps/api/src/queue/queue.module.ts",
  "apps/api/src/modules/health/health.controller.ts",
  "apps/api/src/modules/auth/auth.controller.ts",
  "apps/api/src/modules/library/library.controller.ts",
  "apps/api/src/modules/jobs/jobs.module.ts",
  "prisma/schema.prisma",
  "docker-compose.yml",
  ".env.api.example",
];

test("NestJS API skeleton files exist", () => {
  for (const file of requiredFiles) {
    assert.equal(existsSync(file), true, `${file} should exist`);
  }
});

test("package scripts expose API, Prisma, and Docker commands", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const script of ["api:dev", "api:build", "api:typecheck", "prisma:generate", "docker:up"]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} script should exist`);
  }
});

test("Prisma schema defines core SaaS models", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  for (const model of ["User", "Project", "StoryboardShot", "LibraryItem", "MediaAsset", "Job", "UsageEvent"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`), `${model} model should exist`);
  }
});

test("Root typecheck excludes the NestJS API app", () => {
  const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"));
  assert.ok(tsconfig.exclude.includes("apps/api"));
});
