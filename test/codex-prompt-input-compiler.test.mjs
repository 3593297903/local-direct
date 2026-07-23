import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import fixture20, {
  FIXTURE_SHA256 as FIXTURE_20_SHA256,
  computeFixtureHash as computeFixture20Hash,
} from "./fixtures/batch-generation/batch-generation-20-segment.mjs";
import fixture30, {
  FIXTURE_SHA256 as FIXTURE_30_SHA256,
  computeFixtureHash as computeFixture30Hash,
} from "./fixtures/batch-generation/batch-generation-30-segment.mjs";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  assertCleanCodexPromptInput,
  buildChinesePromptLexiconBlock,
  compileSegmentContractForPrompt,
  compileSegmentContractRenderBlock,
  compileCodexPromptText,
  CONTRACT_PROMPT_COMPILER_VERSION,
  CONTRACT_PROMPT_MAX_BYTES,
  segmentContractToChineseRenderBlock,
} = require("../lib/codex-prompt-input-compiler.ts");
const {
  buildSegmentContractHash,
  normalizeSegmentContract,
} = require("../lib/batch-segment-contract.ts");
const {
  createRenderOperationDraft,
} = require("../lib/batch-render-operation.ts");

function normalizeProductionContract(contract) {
  const raw = structuredClone(contract);
  delete raw.sourceHash;
  delete raw.contractHash;
  return normalizeSegmentContract(raw, {
    segmentIndex: raw.segmentIndex,
    fallbackTitle: raw.title,
    fallbackSourceText: raw.sourceText,
    fallbackDurationSeconds: raw.durationSeconds,
    fallbackShotCount: raw.shotCount,
    forbiddenFutureEvents: raw.forbiddenFutureEvents,
    coveragePolicyVersion: raw.coveragePolicyVersion,
  });
}

function renderInputScriptForContract(contract) {
  return [
    contract.sourceText,
    ...contract.characters.flatMap((item) => Object.values(item)),
    ...contract.locations.flatMap((item) => Object.values(item)),
    ...contract.props.flatMap((item) => Object.values(item)),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n");
}

function createContract(overrides = {}) {
  const contract = normalizeSegmentContract({
    segmentIndex: 1,
    title: "调查室里的证据核验",
    sourceText: "调查员在资料室核验聊天记录，并确认关键证据的时间顺序。",
    durationSeconds: 12,
    shotCount: 4,
    requiredEvents: ["核验聊天记录", "确认时间顺序"],
    requiredEventSlots: [{
      id: "verify_chat_record",
      label: "调查员核验聊天记录",
      importance: "blocking",
      anchorGroups: [["调查员"], ["聊天记录"]],
      conceptGroups: [["核验", "确认"]],
      contradictionGroups: [["没有查看记录"]],
      evidenceSelectors: [
        { source: "optimizedScript", fields: ["dialogue"], requireExecutableShot: false },
        { source: "storyboard", shotNumber: "any", fields: ["visual", "videoPrompt"], requireExecutableShot: true },
      ],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
    forbiddenFutureEvents: ["嫌疑人在下一段被捕"],
    characterLocks: [{
      characterId: "investigator",
      displayName: "调查员",
      factKey: "identity",
      expectedValue: "案件调查人员",
      mode: "must_not_contradict",
      contradictionSignals: [["普通路人", "嫌疑人"]],
    }],
    characters: [{ name: "调查员", identity: "案件调查人员", visualLock: "深色便装" }],
    locations: [{ name: "资料室", visualLock: "冷白顶灯与金属档案柜" }],
    props: [{ name: "聊天记录打印件", role: "关键证据" }],
    requiredShotBeats: [
      { shotNumber: 1, timeRange: "0s-3s", beat: "进入资料室", visualFocus: "调查员推门进入" },
      { shotNumber: 2, timeRange: "3s-6s", beat: "展开记录", visualFocus: "打印件与标记线索" },
      { shotNumber: 3, timeRange: "6s-9s", beat: "核验时间", visualFocus: "时间戳被逐项比对" },
      { shotNumber: 4, timeRange: "9s-12s", beat: "确认顺序", visualFocus: "调查员记录结论" },
    ],
    safetyPolicy: {
      avoidTerms: ["真实机构徽标"],
      rewriteHints: { "真实机构徽标": "抽象机构标识" },
    },
    ...overrides,
  }, {
    segmentIndex: overrides.segmentIndex || 1,
    fallbackTitle: overrides.title || "调查室里的证据核验",
    fallbackSourceText: overrides.sourceText || "调查员在资料室核验聊天记录，并确认关键证据的时间顺序。",
    fallbackDurationSeconds: overrides.durationSeconds || 12,
    fallbackShotCount: overrides.shotCount || 4,
  });
  const withoutHash = { ...contract };
  delete withoutHash.contractHash;
  return { ...contract, contractHash: buildSegmentContractHash(withoutHash) };
}

function contractWithCompiledByteLength(targetBytes) {
  let paddingLength = Math.max(0, targetBytes - 1_600);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const contract = createContract({ title: `边界测试${"x".repeat(paddingLength)}` });
    const compiled = compileSegmentContractForPrompt(contract, { maxBytes: 16_384 });
    assert.equal(compiled.status, "ready");
    if (compiled.byteLength === targetBytes) return contract;
    paddingLength += targetBytes - compiled.byteLength;
    assert.ok(paddingLength >= 0, "boundary fixture padding must remain non-negative");
  }
  throw new Error(`Unable to construct a ${targetBytes}-byte contract projection`);
}

test("compiles known internal prompt tokens into Chinese before Codex sees them", () => {
  const compiled = compileCodexPromptText("Open chat-log, qq_records, forensic_room, and single-segment AnalysisResult.");

  assert.doesNotMatch(compiled, /chat-log|qq_records|forensic_room|single-segment|AnalysisResult/i);
  assert.match(compiled, /聊天记录证据/);
  assert.match(compiled, /QQ聊天记录/);
  assert.match(compiled, /法医室/);
  assert.match(compiled, /单段视频提示词结果/);
  assert.doesNotThrow(() => assertCleanCodexPromptInput(compiled, "compiled test prompt"));
});

test("rejects prompts that still contain internal tokens before generation", () => {
  assert.throws(
    () => assertCleanCodexPromptInput("Use qq_records in the generated prompt.", "dirty test prompt"),
    /contains internal prompt token/,
  );
});

test("formats segment contracts as Chinese render blocks instead of raw JSON schema text", () => {
  const block = segmentContractToChineseRenderBlock(createContract({
    segmentIndex: 1,
    title: "第1段",
    sourceText: "case-room 中打开 chat-log。",
    durationSeconds: 15,
    shotCount: 4,
    requiredEvents: ["chat-log 被读取"],
    forbiddenFutureEvents: ["future event"],
    characters: [],
    locations: [{ name: "case-room" }],
    props: [{ name: "qq_records" }],
    requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-3s", beat: "chat-log", visualFocus: "forensic_room" }],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
  }));

  assert.match(block, /段落契约/);
  assert.match(block, /专案会议室/);
  assert.match(block, /QQ聊天记录/);
  assert.match(block, /聊天记录证据/);
  assert.doesNotMatch(block, /SegmentContract|qq_records|chat-log|forensic_room|case-room/);
});

test("builds a Chinese-only lexicon block from dirty input values", () => {
  const block = buildChinesePromptLexiconBlock(["chat-log", "qq_records", "forensic_room"]);

  assert.match(block, /项目中文词典/);
  assert.match(block, /聊天记录证据/);
  assert.match(block, /QQ聊天记录/);
  assert.match(block, /法医室/);
  assert.doesNotMatch(block, /chat-log|qq_records|forensic_room/);
});

test("compact render contracts expose blocking sidecar slots without literal requiredEvents matching", () => {
  const contract = {
    contractSchemaVersion: 2,
    coveragePolicyVersion: "policy-test",
    sourceHash: "src_test",
    segmentIndex: 25,
    title: "婚姻关系调查",
    sourceText: "庄秦承认夫妻早已没有感情。",
    durationSeconds: 12,
    shotCount: 3,
    requiredEvents: ["婚姻冷淡"],
    requiredEventSlots: [{
      id: "cold_marriage",
      label: "庄秦承认夫妻关系长期冷淡",
      importance: "blocking",
      anchorGroups: [["庄秦", "丈夫"]],
      conceptGroups: [["夫妻", "婚姻"], ["没感情", "冷淡", "疏离"]],
      contradictionGroups: [["感情很好", "婚姻和睦"]],
      evidenceSelectors: [
        { source: "optimizedScript", fields: ["dialogue"], requireExecutableShot: false },
        { source: "storyboard", shotNumber: "any", fields: ["dialogue", "visual"], requireExecutableShot: true },
      ],
      repairTargets: [{ shotNumber: "best_match", field: "dialogue" }],
    }, {
      id: "advisory_note",
      label: "只记录的次要事件",
      importance: "advisory",
      anchorGroups: [["次要人物"]],
      conceptGroups: [["经过"]],
      contradictionGroups: [],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
    forbiddenFutureEvents: ["后续嫌疑人被捕"],
    characterLocks: [{
      characterId: "zhuangqin",
      displayName: "庄秦",
      factKey: "marital_status",
      expectedValue: "婚姻关系仍存续",
      mode: "must_not_contradict",
      contradictionSignals: [["已经离婚"]],
    }],
    characters: [],
    locations: [],
    props: [],
    requiredShotBeats: [{ shotNumber: 1, timeRange: "0s-4s", beat: "调查", visualFocus: "办公室" }],
    safetyPolicy: { avoidTerms: [], rewriteHints: {} },
    contractHash: "sc_cold_marriage",
  };
  contract.contractHash = buildSegmentContractHash(contract);

  const compiled = compileSegmentContractRenderBlock(contract);
  assert.match(compiled.text, /cold_marriage/);
  assert.match(compiled.text, /evidenceSelectors|允许证据路径/);
  assert.match(compiled.text, /optimizedScript/);
  assert.match(compiled.text, /storyboard\[\*\]\.dialogue/);
  assert.match(compiled.text, /没有提及.*不算冲突/);
  assert.match(compiled.text, /剧情理解参考.*不做逐字匹配/);
  assert.doesNotMatch(compiled.text, /必须覆盖所有必须事件/);
  assert.doesNotMatch(compiled.text, /advisory_note/);
  assert.ok(compiled.byteLength <= 3072);
  assert.equal(compiled.wasCompacted, false);
});

test("typed contract compiler honors the exact 3072/3073 UTF-8 byte boundary", () => {
  const exact = compileSegmentContractForPrompt(contractWithCompiledByteLength(3_072));
  const over = compileSegmentContractForPrompt(contractWithCompiledByteLength(3_073));

  assert.equal(CONTRACT_PROMPT_COMPILER_VERSION, "segment-contract-prompt-v2");
  assert.equal(CONTRACT_PROMPT_MAX_BYTES, 3_072);
  assert.equal(exact.status, "ready");
  assert.equal(exact.byteLength, 3_072);
  assert.equal(over.status, "compacted");
  assert.ok(over.byteLength <= 3_072);
});

test("typed contract compiler measures Chinese text as UTF-8 bytes deterministically without mutation", () => {
  const contract = createContract({ title: "中文多字节镜头契约" });
  const before = structuredClone(contract);
  const first = compileSegmentContractForPrompt(contract);
  const second = compileSegmentContractForPrompt(contract);

  assert.ok(first.status === "ready" || first.status === "compacted");
  assert.equal(first.byteLength, new TextEncoder().encode(first.text).byteLength);
  assert.deepEqual(first, second);
  assert.deepEqual(contract, before);
});

test("typed contract compiler returns schema and hash failures instead of throwing", () => {
  const valid = createContract();
  const invalidSchema = { ...valid, contractSchemaVersion: 999 };
  const invalidHash = { ...valid, contractHash: "sc_tampered" };

  const schemaResult = compileSegmentContractForPrompt(invalidSchema);
  assert.equal(schemaResult.status, "invalid");
  assert.equal(schemaResult.compilerVersion, "segment-contract-prompt-v2");
  assert.equal(schemaResult.segmentIndex, valid.segmentIndex);
  assert.equal(schemaResult.contractHash, valid.contractHash);
  assert.equal(schemaResult.errorCode, "CONTRACT_SCHEMA_INVALID");
  assert.match(schemaResult.message, /schema|contractSchemaVersion/i);
  const hashResult = compileSegmentContractForPrompt(invalidHash);
  assert.equal(hashResult.status, "invalid");
  assert.equal(hashResult.errorCode, "CONTRACT_HASH_INVALID");
});

test("historical contracts remain compatibility-readable but authoritative compilation stays strict", () => {
  const historical = structuredClone(createContract());
  historical.contractHash = "sc_historical_identity";
  delete historical.requiredEventSlots[0].repairTargets;
  const before = structuredClone(historical);

  const readable = compileSegmentContractRenderBlock(historical);
  const strict = compileSegmentContractForPrompt(historical);

  assert.match(readable.text, /verify_chat_record/);
  assert.ok(readable.byteLength <= CONTRACT_PROMPT_MAX_BYTES);
  assert.equal(strict.status, "invalid");
  assert.deepEqual(historical, before);
});

test("production-shaped 20 and 30 contracts fit the strict budget without losing asset visibility", () => {
  assert.equal(computeFixture20Hash(fixture20), FIXTURE_20_SHA256);
  assert.equal(computeFixture30Hash(fixture30), FIXTURE_30_SHA256);

  for (const fixture of [fixture20, fixture30]) {
    const normalized = fixture.contracts.map(normalizeProductionContract);
    const compiled = normalized.map((contract) => compileSegmentContractForPrompt(contract));
    assert.equal(compiled.filter((item) => item.status === "invalid").length, 0);
    assert.equal(compiled.filter((item) => item.status === "overflow").length, 0);
    assert.equal(compiled.filter((item) => item.status === "ready" || item.status === "compacted").length, fixture.segmentCount);
    assert.ok(Math.max(...compiled.map((item) => item.byteLength)) <= CONTRACT_PROMPT_MAX_BYTES);

    normalized.forEach((contract, index) => {
      const item = compiled[index];
      assert.ok(item.status === "ready" || item.status === "compacted");
      const modelInput = `${item.text}\n${renderInputScriptForContract(contract)}`;
      for (const lock of [...contract.characters, ...contract.locations, ...contract.props]) {
        assert.match(modelInput, new RegExp(lock.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      if (item.status === "compacted") {
        assert.ok(item.compactedFields.includes("assetDisplayLocks"));
        assert.ok(item.compactedFields.includes("verboseExecutionInstructions"));
      }
    });
  }
});

test("contract projection and manifest do not depend on localeCompare", () => {
  const contract = createContract({
    safetyPolicy: {
      avoidTerms: ["真实标识"],
      rewriteHints: { "乙标识": "抽象乙标识", "甲标识": "抽象甲标识" },
    },
  });
  const baseline = compileSegmentContractForPrompt(contract);
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function forbiddenLocaleCompare() {
      throw new Error("localeCompare must not participate in contract identity");
    };
    const perturbed = compileSegmentContractForPrompt(contract);
    assert.deepEqual(perturbed, baseline);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

test("render operation identity does not depend on localeCompare", () => {
  const input = {
    batchId: "batch-locale-stability",
    operationToken: "operation-locale-stability",
    segmentIndexes: [2, 1],
    sourceHash: "source-locale-stability",
    contractHashes: { 2: "contract-b", 1: "contract-a" },
    reconciliationContext: {
      sourceText: "source",
      segments: [
        { episodeIndex: 1, title: "甲", sourceText: "甲", duration: "12s" },
        { episodeIndex: 2, title: "乙", sourceText: "乙", duration: "12s" },
      ],
    },
    now: "2026-07-16T00:00:00.000Z",
  };
  const baseline = createRenderOperationDraft(input);
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function forbiddenLocaleCompare() {
      throw new Error("localeCompare must not participate in render operation identity");
    };
    assert.deepEqual(createRenderOperationDraft(input), baseline);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

test("full and compact projections preserve the same blocking semantic manifest", () => {
  const verbose = "保持人物、场景和证据关系一致，同时使用可执行的镜头语言。".repeat(35);
  const contract = createContract({
    sourceText: verbose,
  });
  const full = compileSegmentContractForPrompt(contract, { maxBytes: 32_768 });
  const compact = compileSegmentContractForPrompt(contract);

  assert.equal(full.status, "ready");
  assert.ok(full.byteLength > CONTRACT_PROMPT_MAX_BYTES);
  assert.equal(compact.status, "compacted");
  assert.ok(compact.byteLength <= CONTRACT_PROMPT_MAX_BYTES);
  assert.deepEqual(compact.semanticManifest, full.semanticManifest);
  assert.ok(compact.compactedFields.length > 0);
});

test("irreducible blocking semantics return typed overflow without truncation or throw", () => {
  const hugeConcept = "必须完整保留的关键事件语义".repeat(220);
  const contract = createContract({
    requiredEventSlots: [{
      id: "irreducible_event",
      label: hugeConcept,
      importance: "blocking",
      anchorGroups: [["调查员"], ["证据"]],
      conceptGroups: [[hugeConcept]],
      contradictionGroups: [["事件没有发生"]],
      evidenceSelectors: [{ source: "storyboard", shotNumber: "any", fields: ["visual"], requireExecutableShot: true }],
      repairTargets: [{ shotNumber: "best_match", field: "visual" }],
    }],
  });

  const result = compileSegmentContractForPrompt(contract);
  assert.equal(result.status, "overflow");
  assert.equal(result.errorCode, "CONTRACT_BUDGET_EXCEEDED");
  assert.equal(result.recommendedAction, "review");
  assert.ok(result.byteLength > result.maxBytes);
  assert.ok(result.blockingSemanticBytes > result.maxBytes);
  assert.equal(result.semanticManifest.blockingEventSlots[0].id, "irreducible_event");
});
