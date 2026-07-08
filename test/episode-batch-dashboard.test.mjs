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
  assert.match(dashboardSource, /sanitizeBatchSegmentOutput/);
  assert.match(dashboardSource, /sanitizeBatchSegmentText/);
  assert.match(dashboardSource, /sanitizeInternalPromptTokens/);
  assert.match(dashboardSource, /findInternalPromptToken/);
  assert.match(dashboardSource, /classifyBatchRepairReason/);
  assert.match(dashboardSource, /batchRepairReasonLabel/);
  assert.match(dashboardSource, /SLOW_RENDER_PACK_WARNING_MS/);
  assert.match(dashboardSource, /renderPackDurationMs/);
  assert.match(dashboardSource, /isRecoverableRenderPackError/);
  assert.match(dashboardSource, /STRICT_UTF8_RENDER_PACK_MODE/);
  assert.match(dashboardSource, /runRenderPack\(STRICT_UTF8_RENDER_PACK_MODE\)/);
  assert.match(dashboardSource, /allowSplitFallback = true/);
  assert.match(dashboardSource, /splitRenderPacks/);
  assert.match(dashboardSource, /runSegmentRepairPool/);
  assert.match(dashboardSource, /queueReadySegmentSaves/);
  assert.match(dashboardSource, /nextSegmentToSave/);
  assert.match(dashboardSource, /buildRenderPacks/);
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
  assert.match(dashboardSource, /normalizeBatchSegmentResultForQuality\(normalized\)/);
  assert.match(dashboardSource, /JSON\.stringify\(result\)/);
  assert.match(dashboardSource, /segmentTerminologyPattern/);
  assert.match(dashboardSource, /assertBatchSegmentQuality/);
  assert.match(dashboardSource, /user-facing prompt contains internal token/);
  assert.match(dashboardSource, /segmentContract/);
  assert.match(dashboardSource, /contractHash/);
  assert.match(dashboardSource, /assertBatchSegmentContractQuality/);
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

test("dashboard render packs default to strict UTF-8 and do not waste a standard-mode retry first", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /mode: RenderPackCodexMode = STRICT_UTF8_RENDER_PACK_MODE/);
  assert.match(dashboardSource, /runRenderPack\(STRICT_UTF8_RENDER_PACK_MODE\)/);
  assert.doesNotMatch(dashboardSource, /runRenderPack\("standard"\)/);
});

test("dashboard batch quality gate rejects thin but structurally complete segment prompts", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const MIN_BATCH_FULL_PROMPT_LENGTH = 900/);
  assert.match(dashboardSource, /MIN_BATCH_FIELD_LENGTHS/);
  assert.match(dashboardSource, /videoPrompt:\s*40/);
  assert.doesNotMatch(dashboardSource, /videoPrompt:\s*60/);
  assert.match(dashboardSource, /assertBatchShotFieldLength/);
  assert.doesNotMatch(dashboardSource, /fullPrompt\.length < 900/);
});

test("dashboard batch normalizes deterministic segment issues before expensive repair", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /normalizeBatchSegmentResultForQuality/);
  assert.match(dashboardSource, /containsBatchNullishValue/);
  assert.match(dashboardSource, /sanitizeBatchNegativePrompt/);
  assert.doesNotMatch(dashboardSource, /\\b\(\?:undefined\|null\)\\b\/i\.test\(serializedResult\)/);
  assert.doesNotMatch(dashboardSource, /\\b\(\?:undefined\|null\)\\b\/i\.test\(qualityText\)/);
  assert.doesNotMatch(dashboardSource, /不要出现 undefined/);
});

test("dashboard keeps batch memory source text segment-scoped and avoids single-episode wording", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /整段规划 \+ 单段同款生成/);
  assert.match(dashboardSource, /本段生成结果摘要/);
  assert.doesNotMatch(dashboardSource, /整段原始输入摘录/);
  assert.doesNotMatch(dashboardSource, /单集同款生成/);
  assert.doesNotMatch(dashboardSource, /单集生成结果摘要/);
  assert.doesNotMatch(dashboardSource, /本地单集 Codex worker/);
});

test("dashboard caches rendered segments before ordered project saves", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /BATCH_SEGMENT_CACHE_PREFIX/);
  assert.match(dashboardSource, /writeBatchSegmentCache/);
  assert.match(dashboardSource, /window\.localStorage\.setItem/);
  assert.match(dashboardSource, /cachedCount/);
  assert.match(dashboardSource, /savedCount/);
  assert.match(dashboardSource, /"cached"/);
  assert.match(dashboardSource, /已生成并缓存，等待前序保存/);
});

test("dashboard limits duplicate segment repair attempts and can restore cached unsaved segments", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /repairAttemptCounts/);
  assert.match(dashboardSource, /buildBatchRepairAttemptKey/);
  assert.match(dashboardSource, /MAX_BATCH_REPAIR_ATTEMPTS_PER_REASON/);
  assert.match(dashboardSource, /restoreCachedRenderedSegments/);
  assert.match(dashboardSource, /localStorage\.getItem\(batchCacheKey\)/);
  assert.match(dashboardSource, /normalizedCachedResult/);
  assert.match(dashboardSource, /assertBatchSegmentQuality\(script, episodeIndex, normalizedCachedResult/);
  assert.match(dashboardSource, /已恢复缓存分段，继续按顺序保存/);
  assert.match(dashboardSource, /segmentRepairReasons\.delete\(episodeIndex\)/);
  assert.match(dashboardSource, /已有合格缓存，继续按顺序保存/);
  assert.match(dashboardSource, /queueReadySegmentSaves\(\)/);
});

test("dashboard balances render packs so tail segments do not wait for a second wave", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /buildRenderPacks\(episodes/);
  assert.match(dashboardSource, /renderSchedule\.packs/);
  assert.match(dashboardSource, /renderSchedule\.concurrency/);
  assert.match(dashboardSource, /forceProfile: "SINGLE"/);
  assert.match(dashboardSource, /调度策略/);
  assert.doesNotMatch(dashboardSource, /const renderPacks = chunkEpisodesForRenderPacks/);
});

test("dashboard records lightweight batch quality reports without changing the render path", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /createSegmentQualityReport/);
  assert.match(dashboardSource, /summarizeSegmentQualityReports/);
  assert.match(dashboardSource, /updateSegmentQualityReportStatus/);
  assert.match(dashboardSource, /qualityReports/);
  assert.match(dashboardSource, /qualityReportSummary/);
  assert.match(dashboardSource, /qualityReports: Array\.from\(qualityReports\.values\(\)\)/);
  assert.match(dashboardSource, /质量均分/);
  assert.match(dashboardSource, /建议检查/);
  assert.match(dashboardSource, /最高风险/);
  assert.match(dashboardSource, /最慢段/);
  assert.doesNotMatch(dashboardSource, /await createSegmentQualityReport/);
});
