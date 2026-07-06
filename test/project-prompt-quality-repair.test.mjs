import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("segment prompt quality scanner is shared and flags hard project prompt issues", () => {
  const quality = readFileSync("lib/segment-prompt-quality.ts", "utf8");

  assert.match(quality, /analyzeSegmentPromptQuality/);
  assert.match(quality, /summarizeSegmentPromptQuality/);
  assert.match(quality, /EPISODE_TERMINOLOGY_PATTERN/);
  assert.match(quality, /PLACEHOLDER_PATTERN/);
  assert.match(quality, /VERTICAL_CONFLICT_PATTERN/);
  assert.match(quality, /duplicate_shot_visual/);
  assert.match(quality, /short_prompt/);
});

test("Projects page scans saved segments locally and exposes manual repair controls", () => {
  const projects = readFileSync("components/ProjectsClient.tsx", "utf8");

  assert.match(projects, /analyzeSegmentPromptQuality/);
  assert.match(projects, /projectPromptQualityItems/);
  assert.match(projects, /selectedVersionQualityIssues/);
  assert.match(projects, /promptRepairInstruction/);
  assert.match(projects, /runProjectPromptRepair/);
  assert.match(projects, /createProjectPromptRepairCodexJob/);
  assert.match(projects, /\/api\/video-prompt\/jobs/);
  assert.match(projects, /repairInstruction/);
  assert.match(projects, /qualityIssues/);
  assert.match(projects, /修复本段/);
  assert.match(projects, /你想怎么修改/);
  assert.doesNotMatch(projects, /useEffect\(\(\) => \{\s*runProjectPromptRepair/s);
});
