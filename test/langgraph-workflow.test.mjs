import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("analyze API uses LangGraph video director workflow", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const graphSource = await readFile(join(process.cwd(), "lib", "agent", "video-director-graph.ts"), "utf8");
  const aiSource = await readFile(join(process.cwd(), "lib", "ai.ts"), "utf8");
  const routeSource = await readFile(join(process.cwd(), "app", "api", "analyze", "route.ts"), "utf8");

  assert.equal(Boolean(packageJson.dependencies["@langchain/langgraph"]), true);
  assert.match(graphSource, /new StateGraph\(VideoDirectorState\)/);
  assert.match(graphSource, /normalize_input/);
  assert.match(graphSource, /retrieve_knowledge/);
  assert.match(graphSource, /generate_analysis/);
  assert.match(graphSource, /finalize_result/);
  assert.match(graphSource, /knowledgeContext/);
  assert.match(aiSource, /invokeVideoDirectorGraph/);
  assert.match(aiSource, /AI_WORKFLOW === "direct"/);
  assert.match(routeSource, /runtime = "nodejs"/);
});
