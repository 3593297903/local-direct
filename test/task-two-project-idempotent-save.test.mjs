import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const service = readFileSync(
  path.join(root, "apps", "api", "src", "modules", "projects", "projects.service.ts"),
  "utf8",
);
const migrationPath = path.join(
  root,
  "prisma",
  "migrations",
  "20260711000100_project_version_save_idempotency",
  "migration.sql",
);

test("project save uses a scalar advisory try-lock and a dedicated unique idempotency field", () => {
  assert.match(schema, /saveIdempotencyKey\s+String\?\s+@unique/);
  assert.match(service, /pg_try_advisory_xact_lock/);
  assert.match(service, /hashtextextended/);
  assert.doesNotMatch(service, /SELECT\s+pg_advisory_xact_lock\s*\(/);
  assert.match(service, /idempotentReplay/);
  assert.ok(existsSync(migrationPath), "idempotency migration must exist");
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /saveIdempotencyKey/);
  assert.match(migration, /CREATE UNIQUE INDEX/);
  assert.match(migration, /RAISE EXCEPTION/);
});

test("twenty concurrent PostgreSQL saves create one version and replay the same ids", {
  skip: !process.env.TASK_TWO_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.TASK_TWO_DATABASE_URL;
  process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", moduleResolution: "node" });
  const require = createRequire(import.meta.url);
  require("ts-node/register/transpile-only");
  const { PrismaService } = require("../apps/api/src/prisma/prisma.service.ts");
  const { ProjectsService } = require("../apps/api/src/modules/projects/projects.service.ts");
  const prisma = new PrismaService();
  await prisma.$connect();
  const email = `task-two-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const user = await prisma.user.create({ data: { email, passwordHash: "task-two-test-only" } });
  const service = new ProjectsService(prisma);
  const idempotencyKey = `same-save-${Date.now()}`;
  const input = {
    idempotencyKey,
    title: "任务二幂等保存测试",
    originalScript: "脱敏测试原文，只用于验证同一个保存请求不会创建重复项目版本。",
    optimizedScript: "脱敏测试生成文案。",
    contentType: "短剧 / 通用",
    style: "现实主义",
    duration: "12秒",
    status: "needs_review",
    fullVideoPrompt: "完整视频提示词".repeat(100),
    shots: [{ shotNumber: 1, scene: "室内", visual: "人物在桌前查看文件", videoPrompt: "人物在桌前查看文件，镜头缓慢推进。" }],
  };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      service.createProject(user.id, input, `request-${index}`)));
    assert.equal(new Set(results.map((item) => item.projectId)).size, 1);
    assert.equal(new Set(results.map((item) => item.versionId)).size, 1);
    assert.equal(results.filter((item) => item.idempotentReplay === false).length, 1);
    assert.equal(results.filter((item) => item.idempotentReplay === true).length, 19);
    const scopedKey = `${user.id}:${idempotencyKey}`;
    const count = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "ProjectVersion"
      WHERE "saveIdempotencyKey" = ${scopedKey}
    `;
    assert.equal(count[0].count, 1);

    const draft = await service.createProject(user.id, {
      ...input,
      idempotencyKey: `${idempotencyKey}-draft`,
      status: "draft",
    }, "request-draft");
    assert.equal(draft.saved, true);
    assert.notEqual(draft.versionId, results[0].versionId);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
