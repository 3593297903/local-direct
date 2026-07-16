import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("dashboard can generate multiple project segments through a season pack job and save in stable segment order", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /const \[episodeCount, setEpisodeCount\] = useState\(1\)/);
  assert.match(dashboardSource, /type SegmentCountMode = "fixed" \| "auto"/);
  assert.match(dashboardSource, /const \[segmentCountMode, setSegmentCountMode\]/);
  assert.match(dashboardSource, /const \[batchProgress, setBatchProgress\]/);
  assert.match(dashboardSource, /const \[batchProgressTick, setBatchProgressTick\]/);
  assert.match(dashboardSource, /startedAtMs: number/);
  assert.match(dashboardSource, /elapsedMs: number/);
  assert.match(dashboardSource, /formatBatchElapsedMs/);
  assert.match(dashboardSource, /batchElapsedLabel/);
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
  assert.match(dashboardSource, /collectContiguousBatchSaveIndexes/);
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
    /job\.result\?\.segments/,
  );
  assert.match(
    dashboardSource,
    /requestAnalysisWithContext\(\s*renderScript,\s*renderDuration,/s,
  );
  assert.match(
    dashboardSource,
    /const episodeResult = normalizeBatchEpisodeResult/,
  );
  assert.match(dashboardSource, /canonicalizeBatchSegmentResult\(normalized\)/);
  assert.match(dashboardSource, /JSON\.stringify\(result\)/);
  assert.match(dashboardSource, /segmentTerminologyPattern/);
  assert.match(dashboardSource, /legacyFatalCheck/);
  assert.match(dashboardSource, /evaluateBatchSegmentQuality/);
  assert.match(dashboardSource, /canonicalizeBatchSegmentResult/);
  assert.match(dashboardSource, /fullVideoPrompt: canonicalFullVideoPrompt/);
  assert.match(dashboardSource, /filmScript: canonicalFullVideoPrompt/);
  assert.match(dashboardSource, /segmentContract/);
  assert.match(dashboardSource, /contractHash/);
  assert.doesNotMatch(dashboardSource, /assertBatchSegmentContractQuality/);
  assert.match(dashboardSource, /renderBatchSegmentWithQualityRepair/);
  assert.match(dashboardSource, /requestBatchSegmentRepairPatchWithContext/);
  assert.match(dashboardSource, /applyBatchSegmentRepairPatch/);
  assert.doesNotMatch(dashboardSource, /buildBatchSegmentRepairScript/);
  assert.doesNotMatch(dashboardSource, /qq_records 要写成/);
  assert.match(dashboardSource, /15 秒默认 4-5 镜头/);
  assert.match(
    dashboardSource,
    /saveAnalysisProject\(\s*episodeScript,\s*episodeResult,\s*fullVideoPrompt,\s*activeProjectId \|\| undefined,\s*undefined,\s*`\$\{durableBatchId\}:\$\{episodeIndex\}`/s,
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
  const qualityGateSource = await readFile(join(process.cwd(), "lib", "batch-segment-quality-gate.ts"), "utf8");

  assert.match(qualityGateSource, /videoPrompt:\s*\{\s*hard:\s*32,\s*target:\s*40/);
  assert.doesNotMatch(qualityGateSource, /videoPrompt:\s*\{\s*hard:\s*60/);
  assert.doesNotMatch(dashboardSource, /MIN_BATCH_FIELD_LENGTHS/);
  assert.doesNotMatch(dashboardSource, /assertBatchShotFieldLength/);
  assert.doesNotMatch(dashboardSource, /fullPrompt\.length < 900/);
});

test("dashboard batch normalizes deterministic segment issues before expensive repair", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /normalizeBatchSegmentResultForQuality/);
  assert.match(dashboardSource, /evaluateBatchSegmentQuality/);
  assert.match(dashboardSource, /applyDeterministicQualityPatch/);
  assert.match(dashboardSource, /shouldRepairWithCodex/);
  assert.match(dashboardSource, /normalizePatchAndValidateBatchSegment/);
  assert.doesNotMatch(dashboardSource, /containsBatchExecutablePlaceholderText/);
  assert.doesNotMatch(dashboardSource, /containsBatchNullishValue/);
  assert.match(dashboardSource, /sanitizeBatchNegativePrompt/);
  assert.doesNotMatch(dashboardSource, /\\b\(\?:undefined\|null\)\\b\/i\.test\(serializedResult\)/);
  assert.doesNotMatch(dashboardSource, /\\b\(\?:undefined\|null\)\\b\/i\.test\(qualityText\)/);
  assert.doesNotMatch(dashboardSource, /如上\|同上\|见上文\|其他\\s\*\[：:\]\\s\*无\|其它\\s\*\[：:\]\\s\*无\|\^\\s\*略\\s\*\$\/m\.test\(fullPrompt\)/);
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

  assert.match(dashboardSource, /buildSegmentBatchRecoveryKey/);
  assert.match(dashboardSource, /schemaVersion:\s*2/);
  assert.match(dashboardSource, /writeBatchSegmentCache/);
  assert.match(dashboardSource, /\/api\/segment-batch-cache\//);
  assert.match(dashboardSource, /method: "PUT"/);
  assert.match(dashboardSource, /window\.localStorage\.setItem/);
  assert.match(dashboardSource, /cachedCount/);
  assert.match(dashboardSource, /batchCachePersistChain/);
  assert.match(dashboardSource, /segmentStateRecords/);
  assert.match(dashboardSource, /saveStatus === "saved"/);
  assert.doesNotMatch(dashboardSource, /savedSegmentIndexes/);
  assert.match(dashboardSource, /savedCount/);
  assert.match(dashboardSource, /"cached"/);
  assert.match(dashboardSource, /已生成并缓存，等待前序保存/);
  assert.match(dashboardSource, /review_saved/);
  assert.match(dashboardSource, /已保存，待检查/);
});

test("dashboard limits duplicate segment repair attempts and can restore cached unsaved segments", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /repairAttemptCounts/);
  assert.match(dashboardSource, /buildBatchRepairAttemptKey/);
  assert.match(dashboardSource, /MAX_BATCH_REPAIR_ATTEMPTS_PER_REASON/);
  assert.match(dashboardSource, /async function restoreCachedRenderedSegments/);
  assert.match(dashboardSource, /method: "GET"/);
  assert.match(dashboardSource, /cache: "no-store"/);
  assert.match(dashboardSource, /localStorage\.getItem\(batchCacheKey\)/);
  assert.match(dashboardSource, /Array\.isArray\(legacyCache\.segments\)/);
  assert.match(dashboardSource, /needsReviewSegments/);
  assert.match(dashboardSource, /!needsReviewEpisodes\.has\(episode\.episodeIndex\)/);
  assert.match(dashboardSource, /cachedStatus === "saved"/);
  assert.match(dashboardSource, /已从服务端缓存恢复已保存状态/);
  assert.match(dashboardSource, /normalizedCachedResult/);
  assert.match(dashboardSource, /normalizePatchAndValidateBatchSegment\(/);
  assert.match(dashboardSource, /validatedCachedResult/);
  assert.match(dashboardSource, /已恢复缓存分段，继续按顺序保存/);
  assert.match(dashboardSource, /segmentRepairReasons\.delete\(episodeIndex\)/);
  assert.match(dashboardSource, /已有合格缓存，继续按顺序保存/);
  assert.match(dashboardSource, /queueReadySegmentSaves\(\)/);
});

test("dashboard balances render packs so tail segments do not wait for a second wave", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /buildPreflightedRenderPacks\(contractPreflightPlan/);
  assert.match(dashboardSource, /renderSchedule\.packs/);
  assert.match(dashboardSource, /renderSchedule\.concurrency/);
  assert.match(dashboardSource, /forceProfile: "SINGLE"/);
  assert.match(dashboardSource, /调度策略/);
  assert.doesNotMatch(dashboardSource, /const renderPacks = chunkEpisodesForRenderPacks/);
});

test("dashboard preflights contracts before operations and never routes contract failures to prompt repair", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  const restoreIndex = dashboardSource.indexOf("await restoreCachedRenderedSegments()");
  const preflightIndex = dashboardSource.indexOf("preflightSegmentContracts(", restoreIndex);
  const scheduleIndex = dashboardSource.indexOf("buildPreflightedRenderPacks(", preflightIndex);
  const renderInvocationIndex = dashboardSource.indexOf(
    "await renderPackedSegmentsWithQualityRepair(renderPacks[packIndex]",
    scheduleIndex,
  );

  assert.ok(restoreIndex >= 0);
  assert.ok(preflightIndex > restoreIndex);
  assert.ok(scheduleIndex > preflightIndex);
  assert.ok(renderInvocationIndex > scheduleIndex);
  assert.match(dashboardSource, /createRenderOperationDraftFromPreflightPack\(/);
  assert.match(dashboardSource, /partitionPreflightedRenderPackAfterRejection\(/);
  assert.match(dashboardSource, /RENDER_OPERATION_REQUEUED/);
  assert.match(dashboardSource, /CONTRACT_PREFLIGHT_STARTED/);
  assert.match(dashboardSource, /CONTRACT_PREFLIGHT_READY/);
  assert.match(dashboardSource, /CONTRACT_PREFLIGHT_INVALID/);
  assert.match(dashboardSource, /CONTRACT_PREFLIGHT_V2_CREATE_PAUSED/);
  assert.match(dashboardSource, /contractPreflightAttempts/);
  assert.match(dashboardSource, /contractPreflightCompacted/);
  assert.match(dashboardSource, /contractPreflightIsolated/);
  assert.match(dashboardSource, /contractPreflightInvalid/);

  const invalidRouterStart = dashboardSource.indexOf("function markContractPreflightInvalid");
  const invalidRouterEnd = dashboardSource.indexOf("\n    }", invalidRouterStart);
  const invalidRouterSource = dashboardSource.slice(invalidRouterStart, invalidRouterEnd);
  assert.ok(invalidRouterStart >= 0);
  assert.doesNotMatch(invalidRouterSource, /queueSegmentRepair|requestAnalysisWithContext|runCoverageJudgeWave/);

  const runRenderPackStart = dashboardSource.indexOf("async function runRenderPack");
  const durableCreateIndex = dashboardSource.indexOf("await createVideoPromptPackCodexJob", runRenderPackStart);
  const renderMetricIndex = dashboardSource.indexOf('invocationLedger.record("renderPackCalls"', runRenderPackStart);
  assert.ok(durableCreateIndex > runRenderPackStart);
  assert.ok(renderMetricIndex > durableCreateIndex);
  assert.match(dashboardSource, /fingerprint:\s*`render:/);
});

test("dashboard records lightweight batch quality reports without changing the render path", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /createSegmentQualityReport/);
  assert.match(dashboardSource, /summarizeSegmentQualityReports/);
  assert.match(dashboardSource, /updateSegmentQualityReportStatus/);
  assert.match(dashboardSource, /qualityReports/);
  assert.match(dashboardSource, /qualityReportSummary/);
  assert.match(dashboardSource, /qualityReports: Array\.from\(qualityReports\.values\(\)\)/);
  assert.match(dashboardSource, /blockingCount/);
  assert.match(dashboardSource, /patchableCount/);
  assert.match(dashboardSource, /warningCount/);
  assert.match(dashboardSource, /riskCount/);
  assert.match(dashboardSource, /localPatchCount/);
  assert.match(dashboardSource, /codexRepairCount/);
  assert.match(dashboardSource, /\u963b\u65ad/);
  assert.match(dashboardSource, /\u53ef\u672c\u5730\u4fee/);
  assert.match(dashboardSource, /Codex \u4fee\u590d/);
  assert.match(dashboardSource, /质量均分/);
  assert.match(dashboardSource, /建议检查/);
  assert.match(dashboardSource, /最高风险/);
  assert.match(dashboardSource, /最慢段/);
  assert.doesNotMatch(dashboardSource, /await createSegmentQualityReport/);
});

test("dashboard passes path-level quality findings into Codex repair prompts", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.match(dashboardSource, /class BatchSegmentQualityValidationError extends Error/);
  assert.match(dashboardSource, /requestBatchSegmentRepairPatchWithContext/);
  assert.match(dashboardSource, /buildBatchSegmentResultHash/);
  assert.match(dashboardSource, /isAllowedBatchSegmentRepairPath/);
  assert.match(dashboardSource, /applyBatchSegmentRepairPatch/);
  assert.match(dashboardSource, /\/api\/batch-segment-repair\/jobs/);
  assert.doesNotMatch(dashboardSource, /const repairedCandidate/);
  assert.doesNotMatch(dashboardSource, /deriveBatchSegmentRepairPatch/);
  assert.match(dashboardSource, /const repairFindings = error instanceof BatchSegmentQualityValidationError/);
  assert.match(dashboardSource, /existingResult\?: AnalysisResult/);
  assert.match(dashboardSource, /if \(!item\.existingResult\)/);
  assert.match(dashboardSource, /repairExistingBatchSegment\(/);
  assert.match(dashboardSource, /首次结果已保留/);
  assert.doesNotMatch(
    dashboardSource,
    /const repairedRawResult = await requestAnalysisWithContext\(/,
  );
});

test("dashboard checks the season worker runtime before creating a batch", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");
  assert.match(dashboardSource, /\/api\/codex-runtime\/health\?worker=\$\{encodeURIComponent\(workerName\)\}/);
  assert.match(dashboardSource, /CODEX_SKILL_CONFIG_INVALID/);
  assert.match(dashboardSource, /assertCodexWorkerRuntimeHealthy\("season-pack"\)/);
});

test("dashboard no longer performs old shot-count hard throw during save", async () => {
  const dashboardSource = await readFile(join(process.cwd(), "components", "DashboardClient.tsx"), "utf8");

  assert.doesNotMatch(dashboardSource, /episodeInput\.shotCount > 0 && episodeResult\.storyboard\.length !== episodeInput\.shotCount/);
  assert.doesNotMatch(dashboardSource, /\u89c4\u5212\u8981\u6c42 \$\{episodeInput\.shotCount\}/);
});
