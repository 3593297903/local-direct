import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard season pack integration renders each segment with the single-segment generator", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /type SeasonPackCodexJob/);
  assert.match(dashboardSource, /type SeasonPackEpisodeResult/);
  assert.match(dashboardSource, /createSeasonPackCodexJob/);
  assert.match(dashboardSource, /pollSeasonPackCodexJob/);
  assert.match(dashboardSource, /episodeSourceText/);
  assert.match(dashboardSource, /buildBatchEpisodeRenderScript/);
  assert.match(dashboardSource, /BATCH_SINGLE_RENDER_CONCURRENCY/);
  assert.match(dashboardSource, /requestAnalysisWithContext\(\s*renderScript,\s*renderDuration,/s);
  assert.match(dashboardSource, /normalizeBatchEpisodeResult/);
  assert.match(dashboardSource, /const episodeResult = normalizeBatchEpisodeResult/);
  assert.match(dashboardSource, /saveAnalysisProject\(episodeScript, episodeResult, fullVideoPrompt/);
  assert.match(dashboardSource, /episode\.input/);
  assert.doesNotMatch(dashboardSource, /originalScript:\s*script,\s*result:\s*episodeResult/s);
});
