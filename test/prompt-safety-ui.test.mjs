import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard exposes Seedance prompt safety optimization for generated prompts", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(source, /runSeedancePromptSafetyOptimization/);
  assert.match(source, /createPromptSafetyCodexJob/);
  assert.match(source, /pollPromptSafetyCodexJob/);
  assert.match(source, /\/api\/prompt-safety\/jobs/);
  assert.match(source, /Seedance 合规优化/);
  assert.match(source, /prompt-safety:codex-worker/);
  assert.match(source, /optimizedResult/);
  assert.match(source, /saveAnalysisProject\(script, optimizedResult, optimizedPromptText/);
});

test("projects page can optimize the selected episode prompt for Seedance", () => {
  const source = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(source, /runProjectPromptSafetyOptimization/);
  assert.match(source, /buildAnalysisResultFromProjectVersion/);
  assert.match(source, /createPromptSafetyCodexJob/);
  assert.match(source, /pollPromptSafetyCodexJob/);
  assert.match(source, /\/api\/prompt-safety\/jobs/);
  assert.match(source, /Seedance 合规优化/);
  assert.match(source, /optimizedResult/);
  assert.match(source, /originalScript: selectedVersion\.originalScript/);
  assert.match(source, /buildShotTimeRange/);
  assert.doesNotMatch(source, /timeRange:\s*""/);
});
