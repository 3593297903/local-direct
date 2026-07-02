import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard season pack integration keeps per-episode saves compact", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /type SeasonPackCodexJob/);
  assert.match(dashboardSource, /type SeasonPackEpisodeResult/);
  assert.match(dashboardSource, /createSeasonPackCodexJob/);
  assert.match(dashboardSource, /pollSeasonPackCodexJob/);
  assert.match(dashboardSource, /episodeSourceText/);
  assert.match(dashboardSource, /saveAnalysisProject\(episodeScript, episodeResult, fullVideoPrompt/);
  assert.doesNotMatch(dashboardSource, /originalScript:\s*script,\s*result:\s*episodeResult/s);
});
