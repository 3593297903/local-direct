import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { analyzeScriptDirect, normalizeAnalysisInput } from "@/lib/ai";
import { getMergedKnowledgeItems } from "@/lib/library-store";
import { durationSince, logger } from "@/lib/logger";
import type { AnalysisResult, KnowledgeItem, UsedKnowledgeItem, AgentTraceStep } from "@/types";

export type VideoDirectorGraphInput = {
  script: string;
  contentType: string;
  style: string;
  duration: string;
  provider?: string;
  requestId?: string;
  directorContext?: string;
};

const VideoDirectorState = Annotation.Root({
  script: Annotation<string>,
  contentType: Annotation<string>,
  style: Annotation<string>,
  duration: Annotation<string>,
  provider: Annotation<string | undefined>,
  requestId: Annotation<string | undefined>,
  directorContext: Annotation<string | undefined>,
  normalizedDuration: Annotation<string | undefined>,
  knowledgeContext: Annotation<string | undefined>,
  usedKnowledge: Annotation<UsedKnowledgeItem[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  result: Annotation<AnalysisResult | undefined>,
  trace: Annotation<AgentTraceStep[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
});

type VideoDirectorStateType = typeof VideoDirectorState.State;
type VideoDirectorStateUpdate = typeof VideoDirectorState.Update;

type ScoredKnowledgeItem = KnowledgeItem & { score: number };

const keywordRules: Array<{ pattern: RegExp; tags: string[]; boost: number }> = [
  { pattern: /雨|雨夜|水|河|湿|冷/i, tags: ["#雨夜", "#冷灰蓝", "#悬疑"], boost: 22 },
  { pattern: /照片|旧照片|档案|纸条|证据|线索/i, tags: ["#旧照片", "#线索", "#特写", "#证物"], boost: 28 },
  { pattern: /死亡|尸|警|案|调查|秘密|失踪|冰柜/i, tags: ["#悬疑", "#刑侦", "#黑场", "#写实"], boost: 26 },
  { pattern: /废弃|大楼|走廊|厕所|地下室|门/i, tags: ["#废弃", "#空间", "#跟拍", "#主观"], boost: 22 },
  { pattern: /产品|广告|卖点|购买|转化|品牌/i, tags: ["#广告", "#高级感", "#稳定", "#产品"], boost: 24 },
  { pattern: /回忆|过去|梦|记忆|童年/i, tags: ["#回忆", "#叠化", "#光影", "#白闪"], boost: 20 },
];

function compactText(value: string) {
  return value.toLowerCase().replace(/[\s#，。、“”‘’：:；;,.!?！？\-_/]+/g, "");
}

function scoreKnowledgeItem(item: KnowledgeItem, script: string) {
  const compactScript = compactText(script);
  const haystack = compactText([
    item.name,
    item.category,
    item.description,
    item.prompt,
    item.useCase,
    item.avoid || "",
    item.tags.join(" "),
  ].join(" "));

  let score = Math.min(30, item.stability * 0.18);

  for (const tag of item.tags) {
    const tagText = compactText(tag.replace("#", ""));
    if (tagText && compactScript.includes(tagText)) score += 20;
  }

  for (const rule of keywordRules) {
    if (!rule.pattern.test(script)) continue;
    const matchedTags = item.tags.filter((tag) => rule.tags.includes(tag));
    if (matchedTags.length) score += rule.boost + matchedTags.length * 6;
  }

  for (const token of [item.name, item.category]) {
    const normalized = compactText(token);
    if (normalized && (compactScript.includes(normalized) || haystack.includes(compactScript.slice(0, 20)))) {
      score += 14;
    }
  }

  return Math.round(score * 10) / 10;
}

function diversifyKnowledge(items: ScoredKnowledgeItem[]) {
  const quotas: Record<KnowledgeItem["type"], number> = {
    shot: 3,
    camera_movement: 3,
    transition: 3,
    style: 2,
    storyboard_formula: 2,
  };

  const selected: ScoredKnowledgeItem[] = [];
  for (const item of items) {
    const current = selected.filter((entry) => entry.type === item.type).length;
    if (current < quotas[item.type]) selected.push(item);
    if (selected.length >= 10) break;
  }

  return selected;
}

function buildKnowledgeContext(items: ScoredKnowledgeItem[]) {
  if (!items.length) {
    return "未检索到强相关知识库条目。请按通用电影分镜规则生成，但仍要遵守首帧、视频、尾帧、负面提示词完整输出。";
  }

  return items
    .map((item, index) => {
      return [
        `【知识库 ${index + 1}｜${item.type}｜相关度 ${item.score}】`,
        `名称：${item.name}`,
        `分类：${item.category}`,
        `说明：${item.description}`,
        `适用场景：${item.useCase}`,
        `推荐提示词：${item.prompt}`,
        item.avoid ? `必须避免：${item.avoid}` : "",
        `标签：${item.tags.join(" ")}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function toTrace(step: string, detail: string, status: AgentTraceStep["status"] = "ok"): AgentTraceStep {
  return { step, status, detail };
}

const normalizeInputNode: typeof VideoDirectorState.Node = (state) => {
  const normalized = normalizeAnalysisInput(state);
  return {
    duration: normalized.duration,
    normalizedDuration: normalized.duration,
    trace: [
      ...state.trace,
      toTrace("normalize_input", `已标准化输入，总时长锁定为 ${normalized.duration}`),
    ],
  } satisfies VideoDirectorStateUpdate;
};

const retrieveKnowledgeNode: typeof VideoDirectorState.Node = async (state) => {
  const startedAt = Date.now();
  const items = await getMergedKnowledgeItems();
  const scored = items
    .map((item) => ({ ...item, score: scoreKnowledgeItem(item, state.script) }))
    .filter((item) => item.score >= Number(process.env.KNOWLEDGE_MIN_SCORE || 20))
    .sort((a, b) => b.score - a.score);

  const selected = diversifyKnowledge(scored);
  const usedKnowledge: UsedKnowledgeItem[] = selected.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    score: item.score,
  }));
  logger.info("video_director_knowledge_retrieved", {
    requestId: state.requestId,
    durationMs: durationSince(startedAt),
    totalKnowledgeItems: items.length,
    candidateCount: scored.length,
    selectedCount: selected.length,
    selectedTypes: Array.from(new Set(selected.map((item) => item.type))),
  });

  return {
    usedKnowledge,
    knowledgeContext: buildKnowledgeContext(selected),
    trace: [
      ...state.trace,
      toTrace(
        "retrieve_knowledge",
        selected.length
          ? `从知识库检索到 ${selected.length} 条相关镜头/运镜/转场/风格/公式。`
          : "没有检索到高相关知识，使用通用导演规则。",
        selected.length ? "ok" : "warning"
      ),
    ],
  } satisfies VideoDirectorStateUpdate;
};

const generateAnalysisNode: typeof VideoDirectorState.Node = async (state) => {
  const startedAt = Date.now();
  const result = await analyzeScriptDirect({
    script: state.script,
    contentType: state.contentType,
    style: state.style,
    duration: state.duration,
    provider: state.provider,
    requestId: state.requestId,
    knowledgeContext: state.knowledgeContext,
    directorContext: state.directorContext,
  });
  logger.info("video_director_analysis_generated", {
    requestId: state.requestId,
    provider: state.provider || process.env.AI_PROVIDER || "mock",
    durationMs: durationSince(startedAt),
    storyboardCount: result.storyboard.length,
  });

  return {
    result,
    trace: [
      ...state.trace,
      toTrace("generate_analysis", `已通过 ${state.provider || process.env.AI_PROVIDER || "mock"} 生成结构化分镜和视频提示词。`),
    ],
  } satisfies VideoDirectorStateUpdate;
};

const finalizeResultNode: typeof VideoDirectorState.Node = (state) => {
  if (!state.result) throw new Error("LangGraph workflow finished without analysis result");

  const result = state.result as AnalysisResult;
  const knowledgeNames = state.usedKnowledge.map((item) => `知识库：${item.name}`);
  const recommendedItems = Array.from(new Set([...(result.recommendedItems || []), ...knowledgeNames])).slice(0, 14);

  return {
    result: {
      ...result,
      recommendedItems,
      usedKnowledge: state.usedKnowledge,
      agentTrace: [
        ...state.trace,
        toTrace("finalize_result", "已合并知识库引用、Agent 执行轨迹，并返回给前端。"),
      ],
    },
  } satisfies VideoDirectorStateUpdate;
};

export function createVideoDirectorGraph() {
  return new StateGraph(VideoDirectorState)
    .addNode("normalize_input", normalizeInputNode)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("generate_analysis", generateAnalysisNode)
    .addNode("finalize_result", finalizeResultNode)
    .addEdge(START, "normalize_input")
    .addEdge("normalize_input", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "generate_analysis")
    .addEdge("generate_analysis", "finalize_result")
    .addEdge("finalize_result", END)
    .compile();
}

export async function invokeVideoDirectorGraph(input: VideoDirectorGraphInput): Promise<AnalysisResult> {
  const graph = createVideoDirectorGraph();
  const finalState = await graph.invoke({
    ...input,
    trace: [],
    usedKnowledge: [],
  } satisfies Partial<VideoDirectorStateType> & VideoDirectorGraphInput);

  if (!finalState.result) throw new Error("LangGraph workflow returned empty result");
  return finalState.result as AnalysisResult;
}
