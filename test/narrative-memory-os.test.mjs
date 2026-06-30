import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("narrative memory OS schema has characters, loops, quality checks, and semantic-ready memories", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync("prisma/migrations/20260625000200_narrative_memory_os/migration.sql", "utf8");

  assert.match(schema, /model CharacterProfile \{/);
  assert.match(schema, /model StoryLoop \{/);
  assert.match(schema, /enum StoryLoopStatus \{[\s\S]*OPEN[\s\S]*RESOLVED[\s\S]*DROPPED[\s\S]*\}/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*qualityCheck\s+Json\?/);
  assert.match(schema, /model MemoryItem \{[\s\S]*embedding\s+Json\?[\s\S]*embeddingVector\s+Unsupported\("vector"\)\?/);
  assert.match(schema, /model MemoryItem \{[\s\S]*isEnabled\s+Boolean\s+@default\(true\)/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "CharacterProfile"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "StoryLoop"/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "qualityCheck" JSONB/);
});

test("project service writes and retrieves L1-L5 director memory", () => {
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(dto, /narrativeMemory\?: Record<string, unknown>/);
  assert.match(dto, /qualityCheck\?: Record<string, unknown>/);

  assert.match(proxy, /narrativeMemory: payload\.narrativeMemory \|\| memory\.narrativeMemory/);
  assert.match(proxy, /qualityCheck: payload\.qualityCheck \|\| memory\.qualityCheck/);

  assert.match(service, /function deriveNarrativeMemory/);
  assert.match(service, /function deriveCharacterProfiles/);
  assert.match(service, /function deriveStoryLoops/);
  assert.match(service, /function buildLocalEmbedding/);
  assert.match(service, /function formatPgVector/);
  assert.match(service, /async function syncMemoryEmbeddingVectors/);
  assert.match(service, /async findVectorRelatedMemories/);
  assert.match(service, /scoreMemoryItem\(memory, currentScript/);
  assert.match(service, /function deriveQualityCheck/);
  assert.match(service, /upsertCharacterProfiles/);
  assert.match(service, /upsertStoryLoops/);
  assert.match(service, /characterProfiles/);
  assert.match(service, /storyLoops/);
  assert.match(service, /qualityCheck: toJson\(qualityCheck\)/);
  assert.match(service, /await syncMemoryEmbeddingVectors\(this\.prisma, result\.version\.id\)/);
  assert.match(service, /const vectorRelatedMemories = await this\.findVectorRelatedMemories/);
});

test("AI result can carry hidden structured memory without changing full video prompt storage", () => {
  const ai = readFileSync("lib/ai.ts", "utf8");
  const types = readFileSync("types/index.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.match(types, /narrativeMemory\?: NarrativeMemoryResult/);
  assert.match(types, /qualityCheck\?: Record<string, unknown>/);
  assert.match(ai, /NarrativeMemorySchema/);
  assert.match(ai, /qualityCheck: z\.record\(z\.string\(\), z\.unknown\(\)\)\.optional\(\)/);
  assert.match(ai, /Do not mix narrativeMemory or qualityCheck into workflow\.shotPromptText or workflow\.fullVideoPrompt/);
  assert.match(proxy, /result\.narrativeMemory/);
  assert.match(proxy, /result\.qualityCheck/);
  assert.match(proxy, /fullVideoPrompt: payload\.fullVideoPrompt/);
});

test("project page keeps director memory tools hidden from normal users", () => {
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(projects, /storyBible/);
  assert.match(projects, /characterProfiles/);
  assert.match(projects, /storyLoops/);
  assert.match(projects, /memoryItems/);
  assert.match(projects, /qualityCheck/);
  assert.match(projects, /SHOW_DIRECTOR_MEMORY = false/);
  assert.match(projects, /SHOW_DIRECTOR_MEMORY &&/);
});
