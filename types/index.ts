export type KnowledgeType = "transition" | "shot" | "camera_movement" | "style" | "storyboard_formula";

export type KnowledgeItem = {
  id: string;
  type: KnowledgeType;
  category: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  genre?: string;
  stability: number;
  order?: number;
  useCase: string;
  avoid?: string;
  previewUrl?: string;
  previewMimeType?: string;
  posterUrl?: string;
  previewType?: "shadow" | "hand" | "flare" | "eye" | "door" | "whip" | "camera";
};

export type StoryboardShot = {
  shotNumber: number;
  timeRange?: string;
  scene: string;
  visual: string;
  shotType: string;
  composition?: string;
  cameraMovement: string;
  lighting?: string;
  sound?: string;
  dialogue?: string;
  emotion: string;
  transition: string;
  shotPurpose?: string;
  firstFramePrompt: string;
  videoPrompt: string;
  lastFramePrompt: string;
  negativePrompt: string;
  concisePrompt?: string;
};

export type GenerationDiagnosis = {
  genre?: string;
  emotions?: string[];
  pace?: string;
  sceneKeywords?: string[];
  characterState?: string;
  visualFocus?: string[];
  cameraStrategy?: string;
  soundStrategy?: string;
  avoid?: string[];
};

export type PromptWorkflow = {
  sourceAnalysis: string;
  generationDiagnosis?: GenerationDiagnosis;
  coreTheme?: string;
  videoParameterLock?: string;
  screenplay: string;
  filmScript: string;
  fullVideoPrompt: string;
  fullNegativePrompt: string;
  shotPromptText?: string;
  editingPlan?: string;
  concisePrompt: string;
  finalPromptPackage?: string;
};

export type NarrativeMemoryResult = {
  episodeSummary?: string;
  endingState?: string;
  characterState?: string;
  stateVector?: Record<string, unknown>;
  openLoops?: string[];
  resolvedLoops?: string[];
  characters?: Array<Record<string, unknown>>;
  storyLoops?: Array<Record<string, unknown>>;
  memoryItems?: Array<Record<string, unknown>>;
};

export type UsedKnowledgeItem = {
  id: string;
  name: string;
  type: KnowledgeType;
  score: number;
};

export type AgentTraceStep = {
  step: string;
  status: "ok" | "warning" | "error";
  detail: string;
};

export type AnalysisResult = {
  title: string;
  contentType: string;
  duration: string;
  style: string;
  diagnosis: string[];
  optimizedScript: string;
  workflow?: PromptWorkflow;
  storyboard: StoryboardShot[];
  recommendedItems: string[];
  editingNotes: string[];
  narrativeMemory?: NarrativeMemoryResult;
  qualityCheck?: Record<string, unknown>;
  /** LangGraph 工作流执行轨迹，方便前端后续展示“Agent 做了哪些步骤”。 */
  agentTrace?: AgentTraceStep[];
  /** 本次生成实际注入模型的知识库条目。 */
  usedKnowledge?: UsedKnowledgeItem[];
};
