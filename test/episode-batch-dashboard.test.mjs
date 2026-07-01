import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard can generate multiple project episodes sequentially with memory continuity", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const \[episodeCount, setEpisodeCount\] = useState\(1\)/);
  assert.match(dashboardSource, /const \[episodeCountPickerOpen, setEpisodeCountPickerOpen\] = useState\(false\)/);
  assert.match(dashboardSource, /aria-label="生成集数"/);
  assert.match(dashboardSource, /min="1"/);
  assert.match(dashboardSource, /max="30"/);
  assert.match(dashboardSource, /buildBatchEpisodeScript/);
  assert.match(dashboardSource, /runBatchEpisodeGeneration/);
  assert.match(dashboardSource, /for \(let episodeIndex = 1; episodeIndex <= episodeCount; episodeIndex \+= 1\)/);
  assert.match(
    dashboardSource,
    /requestAnalysisWithContext\(episodeScript, selectedDurationValue\(\), activeProjectId \|\| undefined, undefined\)/,
  );
  assert.match(
    dashboardSource,
    /saveAnalysisProject\(episodeScript, episodeResult, fullVideoPrompt, activeProjectId \|\| undefined, undefined\)/,
  );
});
