import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("narrative memory schema stores retrievable memories and narrative state", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync("prisma/migrations/20260625000100_narrative_memory_items/migration.sql", "utf8");

  assert.match(schema, /enum MemoryItemType \{[\s\S]*CHARACTER[\s\S]*OBJECT[\s\S]*SCENE[\s\S]*EVENT[\s\S]*CLUE[\s\S]*STYLE[\s\S]*\}/);
  assert.match(schema, /model Project \{[\s\S]*stateVector\s+Json\?/);
  assert.match(schema, /model Project \{[\s\S]*openLoops\s+Json\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*stateVector\s+Json\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*openLoops\s+Json\?/);
  assert.match(schema, /model MemoryItem \{[\s\S]*type\s+MemoryItemType[\s\S]*importance\s+Float[\s\S]*embedding\s+Json\?/);

  assert.match(migration, /CREATE TYPE "MemoryItemType"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "MemoryItem"/);
  assert.match(migration, /ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "stateVector" JSONB/);
  assert.match(migration, /ALTER TABLE "ProjectVersion" ADD COLUMN IF NOT EXISTS "openLoops" JSONB/);
});

test("project service extracts memory items and retrieves top-k memories for director context", () => {
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(dto, /stateVector\?: Record<string, unknown>/);
  assert.match(dto, /openLoops\?: unknown\[\]/);

  assert.match(service, /function deriveMemoryItems/);
  assert.match(service, /function scoreMemoryItem/);
  assert.match(service, /const MEMORY_RETRIEVAL_LIMIT = 8/);
  assert.match(service, /prisma\.memoryItem\.deleteMany/);
  assert.match(service, /prisma\.memoryItem\.createMany/);
  assert.match(service, /relatedMemories/);
  assert.match(service, /scoreMemoryItem\(memory, currentScript/);
  assert.match(service, /MemoryItemType\.CLUE/);

  assert.match(proxy, /stateVector: payload\.stateVector \|\| memory\.stateVector/);
  assert.match(proxy, /openLoops: payload\.openLoops \|\| memory\.openLoops/);
});
