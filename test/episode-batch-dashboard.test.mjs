import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard can generate multiple project segments through a season pack job and save sequentially", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const \[episodeCount, setEpisodeCount\] = useState\(1\)/);
  assert.match(dashboardSource, /const \[episodeCountPickerOpen, setEpisodeCountPickerOpen\] = useState\(false\)/);
  assert.match(dashboardSource, /aria-label="生成段数"/);
  assert.match(dashboardSource, /min="1"/);
  assert.match(dashboardSource, /max="30"/);
  assert.match(dashboardSource, /runBatchEpisodeGeneration/);
  assert.match(dashboardSource, /createSeasonPackCodexJob/);
  assert.match(dashboardSource, /pollSeasonPackCodexJob/);
  assert.match(dashboardSource, /\/api\/season-pack\/jobs/);
  assert.match(
    dashboardSource,
    /seasonPackJob\.result\?\.episodes/,
  );
  assert.match(
    dashboardSource,
    /buildBatchEpisodeRenderScript/,
  );
  assert.match(
    dashboardSource,
    /requestAnalysisWithContext\(\s*renderScript,\s*renderDuration,/s,
  );
  assert.match(
    dashboardSource,
    /const episodeResult = normalizeBatchEpisodeResult/,
  );
  assert.match(dashboardSource, /assertBatchSegmentQuality/);
  assert.match(dashboardSource, /renderBatchSegmentWithQualityRepair/);
  assert.match(dashboardSource, /buildBatchSegmentRepairScript/);
  assert.match(dashboardSource, /15 秒默认 4-5 镜头/);
  assert.match(
    dashboardSource,
    /saveAnalysisProject\(episodeScript, episodeResult, fullVideoPrompt, activeProjectId \|\| undefined, undefined\)/,
  );
  assert.match(dashboardSource, /第 \{item\.segment\.index\} 段/);
  assert.match(dashboardSource, /\{episodeCount\} 段/);
  assert.doesNotMatch(
    dashboardSource,
    /const episodeResult = normalizeBatchEpisodeResult\(script, episodeIndex, episodeCount, episode\.result/,
  );
});
