import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard generates video prompts through local Codex jobs with analyze fallback", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(source, /createVideoPromptCodexJob/);
  assert.match(source, /pollVideoPromptCodexJob/);
  assert.match(source, /\/api\/video-prompt\/jobs/);
  assert.match(source, /\/api\/video-prompt\/jobs\/\$\{jobId\}/);
  assert.match(source, /requestAnalysisWithProviderFallback/);
  assert.match(source, /\/api\/analyze/);
  assert.match(source, /setResult\(completedJob\.result/);
  assert.match(source, /saveAnalysisProject\(script, singleResult, fullVideoPrompt/);
  assert.match(source, /video-prompt:codex-worker/);
});

test("dashboard preserves completed Codex job failures instead of blindly falling back", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(source, /CodexVideoPromptJobFailedError/);
  assert.match(source, /if \(err instanceof CodexVideoPromptJobFailedError\) throw err/);
  assert.match(source, /res\.json\(\)\.catch\(\(\) => null\)/);
});
