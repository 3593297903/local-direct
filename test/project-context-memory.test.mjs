import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("project memory schema stores user preferences, story bible, and episode memory", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /model User \{[\s\S]*promptPreferences\s+Json\?/);
  assert.match(schema, /model Project \{[\s\S]*storyBible\s+Json\?/);
  assert.match(schema, /model Project \{[\s\S]*contextSummary\s+String\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*episodeSummary\s+String\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*endingState\s+String\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*characterState\s+String\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*memoryJson\s+Json\?/);
  assert.match(schema, /model ProjectVersion \{[\s\S]*contextSnapshot\s+Json\?/);
});

test("Nest projects API exposes a director context package for the next episode", () => {
  const dto = readFileSync("apps/api/src/modules/projects/projects.dto.ts", "utf8");
  const controller = readFileSync("apps/api/src/modules/projects/projects.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/projects/projects.service.ts", "utf8");

  assert.match(dto, /BuildProjectContextDto/);
  assert.match(dto, /currentScript!: string/);
  assert.match(dto, /storyBible\?: Record<string, unknown>/);
  assert.match(dto, /episodeSummary\?: string/);
  assert.match(dto, /endingState\?: string/);
  assert.match(dto, /memoryJson\?: Record<string, unknown>/);

  assert.match(controller, /@Post\(":projectId\/context"\)/);
  assert.match(controller, /buildGenerationContext\(request\.user\.id, projectId, body\.currentScript\)/);

  assert.match(service, /async buildGenerationContext\(userId: string, projectId: string, currentScript: string\)/);
  assert.match(service, /recentEpisodes/);
  assert.match(service, /relatedEpisodes/);
  assert.match(service, /contextText/);
});

test("analysis route fetches director context before calling the AI", () => {
  const analyzeRoute = readFileSync("app/api/analyze/route.ts", "utf8");
  const proxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(proxy, /export async function fetchDirectorContextFromNest/);
  assert.match(proxy, /\/projects\/\$\{projectId\}\/context/);
  assert.match(proxy, /currentScript/);

  assert.match(analyzeRoute, /fetchDirectorContextFromNest/);
  assert.match(analyzeRoute, /const directorContext/);
  assert.match(analyzeRoute, /analyzeScript\(\{[\s\S]*directorContext/);

  assert.match(dashboard, /requestAnalysisWithContext\([\s\S]*inputScript: string[\s\S]*inputDurationSeconds: number[\s\S]*projectId/);
  assert.match(dashboard, /projectId: projectId \|\| undefined/);
});

test("AI provider receives director context without changing the final prompt display contract", () => {
  const ai = readFileSync("lib/ai.ts", "utf8");
  const graph = readFileSync("lib/agent/video-director-graph.ts", "utf8");
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(ai, /directorContext\?: string/);
  assert.match(ai, /directorContextInstruction/);
  assert.match(ai, /directorContext: input\.directorContext \|\| ""/);

  assert.match(graph, /directorContext: Annotation<string \| undefined>/);
  assert.match(graph, /directorContext: state\.directorContext/);

  assert.match(dashboard, /buildVideoGenerationPromptText\(singleResult\)/);
  assert.match(dashboard, /fullVideoPrompt/);
});
