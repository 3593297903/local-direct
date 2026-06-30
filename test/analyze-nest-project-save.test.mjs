import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("analyze route saves generated projects through NestJS projects instead of Supabase", () => {
  const analyzeRoute = readFileSync("app/api/analyze/route.ts", "utf8");
  const projectProxy = readFileSync("lib/nest-projects-proxy.ts", "utf8");

  assert.doesNotMatch(analyzeRoute, /createClient/);
  assert.doesNotMatch(analyzeRoute, /project-store/);
  assert.match(analyzeRoute, /NextRequest/);
  assert.match(analyzeRoute, /projectId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(analyzeRoute, /versionId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(analyzeRoute, /saveAnalysisProjectToNest\(request, body\.script, result, body\.projectId, body\.versionId\)/);

  assert.match(projectProxy, /export async function saveAnalysisProjectToNest/);
  assert.match(projectProxy, /mapAnalysisResultToNestProjectBody/);
  assert.match(projectProxy, /saved: false/);
  assert.match(projectProxy, /saved: true/);
});
