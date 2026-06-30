import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("project versions persist the exact rendered full video prompt", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(schema, /model ProjectVersion \{[\s\S]*fullVideoPrompt\s+String\?/);
  assert.match(dto, /fullVideoPrompt\?: string/);
  assert.match(service, /fullVideoPrompt: input\.fullVideoPrompt/);
  assert.match(service, /fullVideoPrompt: true/);
  assert.match(proxy, /fullVideoPrompt: payload\.fullVideoPrompt/);

  assert.match(dashboard, /const fullVideoPrompt = buildVideoGenerationPromptText\(singleResult\)/);
  assert.match(dashboard, /saveAnalysisProject\(script, singleResult, fullVideoPrompt\)/);
  assert.match(dashboard, /saveAnalysisProject\(segment\.text, segmentResult, fullVideoPrompt, activeProjectId \|\| undefined, undefined\)/);
  assert.doesNotMatch(dashboard, /save:\s*true/);

  assert.match(projects, /fullVideoPrompt\?: string \| null/);
  assert.match(projects, /if \(version\.fullVideoPrompt\) return version\.fullVideoPrompt/);
  assert.match(projects, /视频生成提示词/);
});
