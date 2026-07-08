# Batch Repair Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce unnecessary video-prompt repairs without lowering prompt quality or slowing normal generation.

**Architecture:** Replace the current hard-throw quality gate with a three-layer decision pipeline: local deterministic patching, quality scoring, and Codex repair only for blocking failures. Keep Render Pack, SegmentContract, cache, and ordered saving intact.

**Tech Stack:** Next.js / React / TypeScript, local Codex workers, Node test runner.

---

## Final Pipeline

```text
raw Render Pack result
-> normalizeBatchEpisodeResult()
-> evaluateBatchSegmentQuality()
-> applyDeterministicQualityPatch()
-> evaluateBatchSegmentQuality(patched)
-> no blocking: storeRenderedEpisode()
-> has blocking: buildTargetedRepairInput()
-> queueSegmentRepair()
```

This pipeline must preserve the current user-facing prompt quality. It improves speed by avoiding unnecessary Codex calls, not by accepting bad prompts.

---

## Files

- Create `lib/batch-segment-quality-gate.ts`
  - Pure quality evaluator, score calculator, deterministic patcher, repair decision helper, and safety rewrite helpers.
- Modify `components/DashboardClient.tsx`
  - Use the new gate before `queueSegmentRepair()`.
  - Trigger repair pool after every Render Pack, not only after all packs.
  - Build targeted repair prompts that preserve existing good fields.
- Modify `scripts/video-prompt-codex-worker.mjs`
  - Align default single-segment repair concurrency with frontend concurrency.
- Modify `test/episode-batch-dashboard.test.mjs`
  - Source-level integration tests for flow wiring.
- Create `test/batch-segment-quality-gate.test.mjs`
  - Unit tests for scoring, patching, safety rewrite, and repair routing.
- Modify `test/video-prompt-codex-worker.test.mjs`
  - Verify worker default concurrency is 3.

---

## Quality Decision Model

### Blocking: Codex Repair Required

Only these issues should trigger Codex single-segment repair:

- Render Pack output missing or invalid JSON.
- `storyboard` missing or not an array.
- Storyboard count cannot match `SegmentContract.shotCount`.
- Required shot field is empty and cannot be locally derived.
- `workflow.fullVideoPrompt` is below 900 characters and structured fields are also thin.
- `undefined/null`, `同上`, `如上`, `略`, `见上文` remain after patch.
- Internal system tokens remain after sanitizer.
- `第 X 集 / 本集 / 单集 / 剧集` remains after patch.
- `requiredEventSlots` are truly not covered.
- `forbiddenFutureEvents` are revealed.
- Multiple shots have substantially duplicated visual/videoPrompt content.
- High-risk Seedance-sensitive wording remains after local rewrite.

### Patchable: Local Repair Only

These must not call Codex:

- `第 X 集 / 本集 / 单集` -> `第 X 段 / 本段 / 单段`.
- Empty `dialogue` -> `无`.
- `16:9竖屏` -> `16:9横屏`.
- Missing `negativePrompt` base items -> append base negative items.
- Short `scene` -> derive from scene, shot type, and visual.
- Short `sound` -> derive from environment, action, and dialogue state.
- Short `firstFramePrompt` / `lastFramePrompt` -> derive from visual and videoPrompt.
- Slightly short `videoPrompt` -> combine visual, composition, cameraMovement, lighting, sound, and emotion.
- Missing or short `workflow.fullVideoPrompt` when storyboard is complete -> rebuild with canonical builder.

### Warning: Record Only

These should not block saving:

- A non-core field is between hard minimum and target.
- `videoPrompt` is 32-39 characters but the shot has complete visual, composition, camera movement, lighting, sound, emotion, and shot purpose.
- `emotion` is short but meaningful.
- `transition` is short but executable, such as `硬切`, `淡出`, `声桥`.
- Medium safety risk is already rewritten into a generic visual expression.

### Field Thresholds

Use hard minimum and target values:

```ts
const FIELD_RULES = {
  scene: { hard: 4, target: 8 },
  sound: { hard: 8, target: 16 },
  firstFramePrompt: { hard: 18, target: 24 },
  lastFramePrompt: { hard: 18, target: 24 },
  videoPrompt: { hard: 32, target: 40 },
  visual: { hard: 30, target: 36 },
  composition: { hard: 18, target: 24 },
  lighting: { hard: 14, target: 20 },
  shotPurpose: { hard: 16, target: 20 },
  negativePrompt: { hard: 10, target: 16 },
};
```

Do not lower `MIN_BATCH_FULL_PROMPT_LENGTH` below 900.

---

## Task 1: Add Quality Gate Unit

**Files:**
- Create `lib/batch-segment-quality-gate.ts`
- Create `test/batch-segment-quality-gate.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `test/batch-segment-quality-gate.test.mjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

require("ts-node/register/transpile-only");

const {
  evaluateBatchSegmentQuality,
  applyDeterministicQualityPatch,
  shouldRepairWithCodex,
  rewriteSeedanceSensitiveText,
} = require("../lib/batch-segment-quality-gate.ts");

function makeShot(overrides = {}) {
  return {
    shotNumber: 1,
    timeRange: "0s-3s",
    scene: "审讯室",
    visual: "深夜审讯室里，桌面文件摊开，人物低头看证据。",
    shotType: "近景",
    composition: "人物在画面左侧，证据位于前景。",
    cameraMovement: "缓慢推进",
    lighting: "冷白顶灯压低空间温度。",
    sound: "纸张声",
    dialogue: "",
    emotion: "紧张",
    transition: "硬切",
    shotPurpose: "展示调查压力并推进证据线索。",
    firstFramePrompt: "审讯室桌前",
    videoPrompt: "镜头推进人物看证据，冷光压住脸部。",
    lastFramePrompt: "文件留在桌上",
    negativePrompt: "",
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    title: "第1段",
    duration: "12秒",
    contentType: "短剧 / 刑侦悬疑",
    style: "冷峻写实",
    diagnosis: "",
    optimizedScript: "审讯室里，调查人员翻看聊天记录。",
    workflow: { fullNegativePrompt: "", fullVideoPrompt: "" },
    storyboard: [makeShot()],
    ...overrides,
  };
}

test("patchable short fields do not require Codex repair after local patch", () => {
  const raw = makeResult();
  const firstGate = evaluateBatchSegmentQuality(raw, { segmentIndex: 1, requestedDuration: "12秒" });
  assert.ok(firstGate.patchableFindings.length > 0);
  const patched = applyDeterministicQualityPatch(raw, firstGate.findings);
  const finalGate = evaluateBatchSegmentQuality(patched, { segmentIndex: 1, requestedDuration: "12秒" });
  assert.equal(shouldRepairWithCodex(finalGate), false);
});

test("missing visual remains blocking because it changes the shot substance", () => {
  const raw = makeResult({ storyboard: [makeShot({ visual: "" })] });
  const gate = evaluateBatchSegmentQuality(raw, { segmentIndex: 1, requestedDuration: "12秒" });
  assert.equal(gate.blockingFindings.some((finding) => finding.field === "visual"), true);
  assert.equal(shouldRepairWithCodex(gate), true);
});

test("sensitive institution wording is rewritten locally without Codex", () => {
  const text = "公安局门口出现警徽和国徽特写";
  const rewritten = rewriteSeedanceSensitiveText(text);
  assert.equal(rewritten.includes("公安局"), false);
  assert.equal(rewritten.includes("警徽"), false);
  assert.equal(rewritten.includes("国徽"), false);
  assert.match(rewritten, /城市执法机构|官方标识/);
});

test("quality score allows warnings but blocks true summary output", () => {
  const usable = makeResult();
  const usableGate = evaluateBatchSegmentQuality(usable, { segmentIndex: 1, requestedDuration: "12秒" });
  assert.ok(usableGate.score >= 70);

  const thin = makeResult({
    workflow: { fullVideoPrompt: "人物看证据。", fullNegativePrompt: "" },
    storyboard: [makeShot({ visual: "人物看证据", composition: "", videoPrompt: "人物看证据" })],
  });
  const thinGate = evaluateBatchSegmentQuality(thin, { segmentIndex: 1, requestedDuration: "12秒" });
  assert.equal(thinGate.blockingFindings.length > 0, true);
});
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
node --test test\batch-segment-quality-gate.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement module**

Create `lib/batch-segment-quality-gate.ts`:

```ts
import type { AnalysisResult } from "@/types";
import { findInternalPromptToken, sanitizeInternalPromptTokensDeep } from "./internal-prompt-token-sanitizer";

export type BatchSegmentFindingSeverity = "blocking" | "patchable" | "warning" | "risk";

export type BatchSegmentFinding = {
  severity: BatchSegmentFindingSeverity;
  code: string;
  field?: string;
  shotIndex?: number;
  message: string;
};

export type BatchSegmentQualityGate = {
  score: number;
  findings: BatchSegmentFinding[];
  blockingFindings: BatchSegmentFinding[];
  patchableFindings: BatchSegmentFinding[];
  warningFindings: BatchSegmentFinding[];
  riskFindings: BatchSegmentFinding[];
};

const FIELD_RULES: Record<string, { hard: number; target: number; core?: boolean }> = {
  scene: { hard: 4, target: 8 },
  sound: { hard: 8, target: 16 },
  firstFramePrompt: { hard: 18, target: 24 },
  lastFramePrompt: { hard: 18, target: 24 },
  videoPrompt: { hard: 32, target: 40, core: true },
  visual: { hard: 30, target: 36, core: true },
  composition: { hard: 18, target: 24 },
  lighting: { hard: 14, target: 20 },
  shotPurpose: { hard: 16, target: 20 },
  negativePrompt: { hard: 10, target: 16 },
};

const REQUIRED_SHOT_FIELDS = [
  "timeRange",
  "scene",
  "visual",
  "shotType",
  "composition",
  "cameraMovement",
  "lighting",
  "sound",
  "dialogue",
  "emotion",
  "transition",
  "shotPurpose",
  "firstFramePrompt",
  "videoPrompt",
  "lastFramePrompt",
  "negativePrompt",
];

const SEEDANCE_REWRITE_MAP: Array<[RegExp, string]> = [
  [/公安局/g, "城市执法机构"],
  [/警徽/g, "官方标识"],
  [/国徽/g, "官方标识"],
  [/真实公安标识/g, "抽象机构标识"],
  [/政治人物/g, "公共人物"],
  [/血泊/g, "地面深色水痕"],
  [/伤口特写/g, "受伤痕迹的克制远景"],
];

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactLength(value: unknown) {
  return clean(value).replace(/\s+/g, "").length;
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(collectText).join("\n");
  return "";
}

export function rewriteSeedanceSensitiveText(text: string) {
  return SEEDANCE_REWRITE_MAP.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function expandFromShot(shot: Record<string, unknown>, field: string, fallback: string) {
  const current = clean(shot[field]);
  const rule = FIELD_RULES[field];
  if (!rule || compactLength(current) >= rule.target) return current;
  const parts = [
    current,
    clean(shot.scene),
    clean(shot.shotType),
    clean(shot.visual),
    clean(shot.composition),
    clean(shot.cameraMovement),
    clean(shot.lighting),
    clean(shot.sound),
    clean(shot.emotion),
    fallback,
  ].filter(Boolean);
  return Array.from(new Set(parts)).join("，");
}

export function applyDeterministicQualityPatch<T extends AnalysisResult>(result: T, _findings: BatchSegmentFinding[] = []): T {
  const sanitized = sanitizeInternalPromptTokensDeep(result) as T;
  const storyboard = Array.isArray(sanitized.storyboard)
    ? sanitized.storyboard.map((shot) => {
        const patched = { ...shot } as Record<string, unknown>;
        patched.dialogue = clean(patched.dialogue) || "无";
        patched.scene = expandFromShot(patched, "scene", "保持本段原文空间和人物关系");
        patched.sound = expandFromShot(patched, "sound", "保留环境声、动作声和必要停顿");
        patched.firstFramePrompt = expandFromShot(patched, "firstFramePrompt", "作为本镜头起始画面");
        patched.lastFramePrompt = expandFromShot(patched, "lastFramePrompt", "作为本镜头结束画面");
        patched.videoPrompt = expandFromShot(patched, "videoPrompt", "补足动作、空间、运镜、光影、声音和情绪连续性");
        const negativeParts = clean(patched.negativePrompt)
          .split(/[，,、]/)
          .map((item) => item.trim())
          .filter(Boolean);
        patched.negativePrompt = Array.from(new Set([
          ...negativeParts,
          "空字段或占位文本",
          "同上",
          "如上",
          "略",
          "16:9竖屏",
          "内部系统标识",
        ])).join("，");
        return Object.fromEntries(
          Object.entries(patched).map(([key, value]) => [key, typeof value === "string" ? rewriteSeedanceSensitiveText(value) : value]),
        );
      })
    : sanitized.storyboard;

  const workflow = sanitized.workflow
    ? Object.fromEntries(
        Object.entries({
          ...sanitized.workflow,
          fullNegativePrompt: clean(sanitized.workflow.fullNegativePrompt)
            || "空字段或占位文本，同上，如上，略，16:9竖屏，内部系统标识",
        }).map(([key, value]) => [key, typeof value === "string" ? rewriteSeedanceSensitiveText(value) : value]),
      )
    : sanitized.workflow;

  return {
    ...sanitized,
    optimizedScript: rewriteSeedanceSensitiveText(clean(sanitized.optimizedScript)),
    workflow: workflow as T["workflow"],
    storyboard: storyboard as T["storyboard"],
  };
}

export function evaluateBatchSegmentQuality(
  result: AnalysisResult,
  options: { segmentIndex: number; requestedDuration: string; minimumFullPromptLength?: number } = { segmentIndex: 1, requestedDuration: "15秒" },
): BatchSegmentQualityGate {
  const findings: BatchSegmentFinding[] = [];
  const storyboard = Array.isArray(result.storyboard) ? result.storyboard : [];

  if (!storyboard.length) {
    findings.push({ severity: "blocking", code: "missing_storyboard", message: `第 ${options.segmentIndex} 段缺少 storyboard` });
  }

  storyboard.forEach((shot, shotIndex) => {
    const record = shot as Record<string, unknown>;
    for (const field of REQUIRED_SHOT_FIELDS) {
      const value = clean(record[field]);
      if (!value) {
        findings.push({
          severity: field === "dialogue" ? "patchable" : "blocking",
          code: "missing_required_field",
          field,
          shotIndex,
          message: `第 ${options.segmentIndex} 段镜头 ${shotIndex + 1} 缺少 ${field}`,
        });
        continue;
      }
      const rule = FIELD_RULES[field];
      if (!rule) continue;
      const length = compactLength(value);
      if (length < rule.hard) {
        findings.push({
          severity: rule.core ? "blocking" : "patchable",
          code: "below_hard_minimum",
          field,
          shotIndex,
          message: `第 ${options.segmentIndex} 段镜头 ${shotIndex + 1} 的 ${field} 低于硬底线`,
        });
      } else if (length < rule.target) {
        findings.push({
          severity: "warning",
          code: "below_target_length",
          field,
          shotIndex,
          message: `第 ${options.segmentIndex} 段镜头 ${shotIndex + 1} 的 ${field} 低于目标长度但可用`,
        });
      }
    }
  });

  const text = collectText(result);
  if (findInternalPromptToken(text)) {
    findings.push({ severity: "blocking", code: "internal_token", message: "提示词包含内部系统标识" });
  }
  if (/\b(?:undefined|null)\b/i.test(text) || /同上|如上|见上文|^\s*略\s*$/m.test(text)) {
    findings.push({ severity: "blocking", code: "placeholder_text", message: "提示词包含空字段或占位文本" });
  }
  if (/第\s*[0-9一二三四五六七八九十百]+\s*集|本集|单集|剧集/.test(text)) {
    findings.push({ severity: "patchable", code: "episode_terminology", message: "提示词仍包含集/本集/单集术语" });
  }
  if (/公安局|警徽|国徽|真实公安标识|血泊|伤口特写/.test(text)) {
    findings.push({ severity: "risk", code: "seedance_sensitive", message: "提示词含 Seedance 敏感表达，应本地泛化" });
  }

  const fullPrompt = clean(result.workflow?.fullVideoPrompt) || text;
  const minimumFullPromptLength = options.minimumFullPromptLength || 900;
  if (fullPrompt.length < minimumFullPromptLength && findings.some((finding) => finding.code === "below_hard_minimum" || finding.code === "missing_required_field")) {
    findings.push({ severity: "blocking", code: "thin_full_prompt", message: `完整视频提示词低于 ${minimumFullPromptLength} 字且字段偏薄` });
  }

  let score = 100;
  for (const finding of findings) {
    if (finding.severity === "blocking") score -= 35;
    if (finding.severity === "patchable") score -= 8;
    if (finding.severity === "warning") score -= 3;
    if (finding.severity === "risk") score -= 6;
  }
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    findings,
    blockingFindings: findings.filter((finding) => finding.severity === "blocking"),
    patchableFindings: findings.filter((finding) => finding.severity === "patchable"),
    warningFindings: findings.filter((finding) => finding.severity === "warning"),
    riskFindings: findings.filter((finding) => finding.severity === "risk"),
  };
}

export function shouldRepairWithCodex(gate: BatchSegmentQualityGate) {
  return gate.blockingFindings.length > 0;
}
```

- [ ] **Step 4: Run unit test**

Run:

```powershell
node --test test\batch-segment-quality-gate.test.mjs
```

Expected: PASS.

---

## Task 2: Wire Gate Into Dashboard

**Files:**
- Modify `components/DashboardClient.tsx`
- Modify `test/episode-batch-dashboard.test.mjs`

- [ ] **Step 1: Add wiring test**

Append to `test/episode-batch-dashboard.test.mjs`:

```js
test("dashboard evaluates, patches, re-evaluates, and only repairs blocking findings", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("components/DashboardClient.tsx", "utf8");
  assert.match(source, /evaluateBatchSegmentQuality/);
  assert.match(source, /applyDeterministicQualityPatch/);
  assert.match(source, /shouldRepairWithCodex/);
  assert.match(source, /const firstGate = evaluateBatchSegmentQuality/);
  assert.match(source, /const patchedResult = applyDeterministicQualityPatch/);
  assert.match(source, /const finalGate = evaluateBatchSegmentQuality/);
  assert.match(source, /if \(!shouldRepairWithCodex\(finalGate\)\)/);
});
```

- [ ] **Step 2: Import helpers**

Add to `components/DashboardClient.tsx`:

```ts
import {
  applyDeterministicQualityPatch,
  evaluateBatchSegmentQuality,
  shouldRepairWithCodex,
} from "@/lib/batch-segment-quality-gate";
```

- [ ] **Step 3: Replace direct hard repair after Render Pack**

Inside `renderPackedSegmentsWithQualityRepair`, replace the direct `assertBatchSegmentQuality()` catch path with:

```ts
const firstGate = evaluateBatchSegmentQuality(episodeResult, {
  segmentIndex: episodeIndex,
  requestedDuration: renderDuration,
  minimumFullPromptLength: minimumBatchFullPromptLength(episodeResult.storyboard || []),
});
const patchedResult = applyDeterministicQualityPatch(episodeResult, firstGate.findings);
const finalGate = evaluateBatchSegmentQuality(patchedResult, {
  segmentIndex: episodeIndex,
  requestedDuration: renderDuration,
  minimumFullPromptLength: minimumBatchFullPromptLength(patchedResult.storyboard || []),
});

try {
  assertBatchSegmentQuality(script, episodeIndex, patchedResult, renderDuration, episodeInput.segmentContract);
} catch (error) {
  const message = error instanceof Error ? error.message : "单段质量校验失败";
  const isMinorFieldIssue = /字段过短|scene|sound|firstFramePrompt|lastFramePrompt|videoPrompt/.test(message)
    && !shouldRepairWithCodex(finalGate);
  if (!isMinorFieldIssue) {
    finalGate.blockingFindings.push({ severity: "blocking", code: "legacy_quality_gate", message });
  }
}

if (!shouldRepairWithCodex(finalGate)) {
  storeRenderedEpisode(episode, patchedResult, {
    status: "cached",
    renderStartedAt: packStartedAt,
    renderCompletedAt: packCompletedAt,
    durationMs: packDurationMs || Math.max(0, packCompletedAt - packStartedAt),
    packIndex,
    packSize: packEpisodes.length,
  });
  continue;
}

const reason = finalGate.blockingFindings.map((finding) => finding.message).join("；");
publishBatchProgress("repairing", `第 ${episodeIndex} / ${resolvedSegmentCount} 段存在阻断级问题，正在单段重修：${reason}`);
queueSegmentRepair(episode, reason);
```

- [ ] **Step 4: Run wiring test**

Run:

```powershell
node --test test\episode-batch-dashboard.test.mjs
```

Expected: PASS.

---

## Task 3: Targeted Repair Prompt

**Files:**
- Modify `components/DashboardClient.tsx`
- Modify `test/episode-batch-dashboard.test.mjs`

- [ ] **Step 1: Add source test**

Append:

```js
test("dashboard repair prompt targets blocking fields without rewriting the whole segment", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("components/DashboardClient.tsx", "utf8");
  assert.match(source, /只修复阻断级问题/);
  assert.match(source, /其他已经合格的字段必须原样保留/);
  assert.match(source, /禁止重新创作整段剧情/);
});
```

- [ ] **Step 2: Update repair prompt builder**

In `buildBatchSegmentRepairScript`, include these rules:

```ts
"修复方式：只修复阻断级问题，其他已经合格的字段必须原样保留。",
"禁止重新创作整段剧情，不要改动已经合格的镜头顺序、人物关系、场景和道具。",
"如果只是字段略短，请在原句基础上补充空间、动作、光影、声音或情绪，不要替换整段。",
"输出仍然必须是完整视频提示词 JSON，但未列为问题的字段必须保持原含义和原画面设计。",
```

- [ ] **Step 3: Run source test**

Run:

```powershell
node --test test\episode-batch-dashboard.test.mjs
```

Expected: PASS.

---

## Task 4: Repair Queue Timing and Dedup

**Files:**
- Modify `components/DashboardClient.tsx`
- Modify `test/episode-batch-dashboard.test.mjs`

- [ ] **Step 1: Add source test**

Append:

```js
test("dashboard deduplicates repair findings and runs repair pool after each pack", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("components/DashboardClient.tsx", "utf8");
  assert.match(source, /buildBatchRepairFindingFingerprint/);
  assert.match(source, /repairFindingFingerprints/);
  assert.match(source, /await runSegmentRepairPool\(\);[\s\S]*queueReadySegmentSaves\(\);/);
});
```

- [ ] **Step 2: Add fingerprint helper**

Near `buildBatchRepairAttemptKey`, add:

```ts
function buildBatchRepairFindingFingerprint(episodeIndex: number, reasonType: BatchRepairReasonType, reason: string) {
  return `${episodeIndex}:${reasonType}:${reason.replace(/\s+/g, "").slice(0, 160)}`;
}
```

Inside batch generation scope, add:

```ts
const repairFindingFingerprints = new Set<string>();
```

Inside `queueSegmentRepair`, before `repairQueue.push(...)`, add:

```ts
const fingerprint = buildBatchRepairFindingFingerprint(episode.episodeIndex, reasonType, reason);
if (repairFindingFingerprints.has(fingerprint)) {
  updateSegmentProgress(episode.episodeIndex, "failed", `同一阻断问题已处理过，停止重复重修：${reason}`);
  return;
}
repairFindingFingerprints.add(fingerprint);
```

- [ ] **Step 3: Run repair pool after each pack**

At the end of `renderPackedSegmentsWithQualityRepair`, after evaluating the pack:

```ts
await runSegmentRepairPool();
queueReadySegmentSaves();
```

Keep the final `await runSegmentRepairPool()` after all packs as a drain.

- [ ] **Step 4: Run source test**

Run:

```powershell
node --test test\episode-batch-dashboard.test.mjs
```

Expected: PASS.

---

## Task 5: Align Repair Worker Concurrency

**Files:**
- Modify `scripts/video-prompt-codex-worker.mjs`
- Modify `test/video-prompt-codex-worker.test.mjs`

- [ ] **Step 1: Add test**

In `test/video-prompt-codex-worker.test.mjs`, add:

```js
test("video prompt worker default concurrency matches dashboard repair concurrency", () => {
  const { readFileSync } = require("node:fs");
  const source = readFileSync("scripts/video-prompt-codex-worker.mjs", "utf8");
  assert.match(source, /positiveInteger\(process\.env\.VIDEO_PROMPT_CODEX_CONCURRENCY,\s*3\)/);
});
```

- [ ] **Step 2: Change worker default**

In `scripts/video-prompt-codex-worker.mjs`, change:

```js
positiveInteger(process.env.VIDEO_PROMPT_CODEX_CONCURRENCY, 2)
```

to:

```js
positiveInteger(process.env.VIDEO_PROMPT_CODEX_CONCURRENCY, 3)
```

- [ ] **Step 3: Run test**

Run:

```powershell
node --test test\video-prompt-codex-worker.test.mjs
```

Expected: PASS.

---

## Task 6: Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run targeted tests**

```powershell
node --test test\batch-segment-quality-gate.test.mjs test\episode-batch-dashboard.test.mjs test\video-prompt-codex-worker.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run batch-related tests**

```powershell
node --test test\batch-render-scheduler.test.mjs test\batch-segment-contract.test.mjs test\batch-segment-quality-report.test.mjs test\video-prompt-pack-codex-queue.test.mjs test\season-pack-codex-queue.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run full checks**

```powershell
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 4: Manual QA**

Generate one 20-segment batch and verify:

- Short `scene`, `sound`, `firstFramePrompt`, `lastFramePrompt`, and slightly short `videoPrompt` are locally patched.
- Repair count is lower than before.
- Fatal failures still enter Codex single-segment repair.
- Repair starts after pack completion instead of waiting for all packs.
- No generated prompt contains internal English tokens unless they came from source text as meaningful content.
- Prompt quality is not thinner than the current generated standard.

---

## Claude Supervision Checklist

- `MIN_BATCH_FULL_PROMPT_LENGTH` remains at least 900.
- `videoPrompt` hard threshold is 32 and target threshold is 40.
- Warnings do not trigger Codex repair.
- Patchable findings are locally patched before repair.
- Blocking findings still stop saving and trigger single-segment repair.
- Sensitive terms are locally rewritten before final caching.
- Codex repair prompt preserves existing good fields.
- Repair fingerprints prevent repeated identical repairs.
- Repair pool can run after each Render Pack.
- Worker default repair concurrency is 3.
- All new behavior has tests.
