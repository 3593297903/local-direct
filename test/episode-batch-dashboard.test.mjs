import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard can generate multiple project segments through a season pack job and save sequentially", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const \[episodeCount, setEpisodeCount\] = useState\(1\)/);
  assert.match(dashboardSource, /type SegmentCountMode = "fixed" \| "auto"/);
  assert.match(dashboardSource, /const \[segmentCountMode, setSegmentCountMode\]/);
  assert.match(dashboardSource, /const \[batchProgress, setBatchProgress\]/);
  assert.match(dashboardSource, /const \[episodeCountPickerOpen, setEpisodeCountPickerOpen\] = useState\(false\)/);
  assert.match(dashboardSource, /aria-label="生成段数"/);
  assert.match(dashboardSource, /min="1"/);
  assert.match(dashboardSource, /max="30"/);
  assert.match(dashboardSource, /runBatchEpisodeGeneration/);
  assert.match(dashboardSource, /createSeasonPackCodexJob/);
  assert.match(dashboardSource, /pollSeasonPackCodexJob/);
  assert.match(dashboardSource, /runSeasonPackPlanningWithLockedRetry/);
  assert.match(dashboardSource, /isMissingLockedSeasonPlanError/);
  assert.match(dashboardSource, /\/api\/season-pack\/jobs/);
  assert.match(dashboardSource, /BATCH_RENDER_PACK_SIZE = 4/);
  assert.match(dashboardSource, /BATCH_RENDER_PACK_CONCURRENCY = 4/);
  assert.match(dashboardSource, /BATCH_SINGLE_RENDER_CONCURRENCY = 3/);
  assert.match(dashboardSource, /type VideoPromptPackCodexJob/);
  assert.match(dashboardSource, /createVideoPromptPackCodexJob/);
  assert.match(dashboardSource, /pollVideoPromptPackCodexJob/);
  assert.match(dashboardSource, /\/api\/video-prompt-packs\/jobs/);
  assert.match(dashboardSource, /renderPackedSegmentsWithQualityRepair/);
  assert.match(dashboardSource, /isRecoverableRenderPackError/);
  assert.match(dashboardSource, /STRICT_UTF8_RENDER_PACK_MODE/);
  assert.match(dashboardSource, /createVideoPromptPackCodexJob\(packSegments, activeProjectId \|\| undefined, STRICT_UTF8_RENDER_PACK_MODE\)/);
  assert.match(dashboardSource, /allowSplitFallback = true/);
  assert.match(dashboardSource, /splitRenderPacks/);
  assert.match(dashboardSource, /runSegmentRepairPool/);
  assert.match(dashboardSource, /queueReadySegmentSaves/);
  assert.match(dashboardSource, /nextSegmentToSave/);
  assert.match(dashboardSource, /chunkEpisodesForRenderPacks/);
  assert.match(dashboardSource, /segmentCountMode/);
  assert.match(dashboardSource, /segmentCountMode === "auto" \|\| episodeCount > 1/);
  assert.match(dashboardSource, /resolvedSegmentCount/);
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
    /renderPackJob\.result\?\.segments/,
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
  assert.match(dashboardSource, /await saveChain/);
  assert.match(dashboardSource, /第 \{item\.segment\.index\} 段/);
  assert.match(dashboardSource, /\{episodeCount\} 段/);
  assert.doesNotMatch(
    dashboardSource,
    /const episodeResult = normalizeBatchEpisodeResult\(script, episodeIndex, episodeCount, episode\.result/,
  );
});
