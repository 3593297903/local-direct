import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("dashboard saves projects only after building the rendered full video prompt", () => {
  const dashboard = readFileSync("components/DashboardClient.tsx", "utf8");

  assert.match(dashboard, /fetch\("\/api\/analyze"/);
  assert.doesNotMatch(dashboard, /save:\s*true/);
  assert.match(dashboard, /fetch\("\/api\/projects"/);
  assert.match(dashboard, /const fullVideoPrompt = buildVideoGenerationPromptText\(singleResult\)/);
  assert.match(dashboard, /fullVideoPrompt,\s*[\r\n\s]*\}\)/);
});
