export type PromptSafetyPolicyPhase = "planning" | "render" | "quality" | "repair" | "promptSafety";

export type PromptSafetyPolicySeverity = "high" | "medium" | "low";

export type PromptSafetyPathClass =
  | "EXECUTABLE_VISUAL"
  | "EXECUTABLE_AUDIO_TEXT"
  | "NEGATIVE_CONSTRAINT"
  | "NARRATIVE_METADATA"
  | "CANONICAL_EXECUTABLE"
  | "ARCHIVE_DERIVED";

export type PromptSafetyPolarity = "affirmative" | "negative_constraint" | "negated_fact";

export type PromptSafetyDecisionSeverity = "blocking" | "risk" | "warning";

export type PromptSafetyContext = {
  phase: PromptSafetyPolicyPhase;
  path?: string;
  field?: string;
  segmentIndex?: number;
};

export type PromptSafetyRule = {
  id: string;
  severity: PromptSafetyPolicySeverity;
  pattern: RegExp;
  replacement?: string;
  negativePromptReplacement?: string;
  reason: string;
  appliesTo: PromptSafetyPolicyPhase[];
};

export type PromptSafetyPolicyFinding = {
  id: string;
  severity: PromptSafetyPolicySeverity;
  match: string;
  replacement?: string;
  reason: string;
  path?: string;
  field?: string;
};

export type PromptSafetySemanticFinding = {
  fingerprint: string;
  ruleId: string;
  severity: PromptSafetyDecisionSeverity;
  policySeverity: PromptSafetyPolicySeverity;
  match: string;
  replacement?: string;
  reason: string;
  normalizedClause: string;
  semanticGroup: string;
  pathClass: PromptSafetyPathClass;
  polarity: PromptSafetyPolarity;
  primaryPath: string;
  affectedPaths: string[];
  affectedPathCount: number;
  requiresCodexRepair: boolean;
};

export type PromptSafetyTreeResult<T> = {
  value: T;
  findings: PromptSafetySemanticFinding[];
  diffs: PromptSafetyDiff[];
  highestRisk: PromptSafetyRisk;
};

export type PromptSafetyRisk = "none" | "low" | "medium" | "high";

export type PromptSafetyDiff = {
  path: string;
  ruleId: string;
  severity: PromptSafetyPolicySeverity;
  before: string;
  after: string;
  phase: PromptSafetyPolicyPhase;
  reason: string;
};

export type PromptSafetyPrepassResult<T> = {
  sourceTextOriginal: T;
  sourceTextForModel: T;
  safetyDiffs: PromptSafetyDiff[];
  highestRisk: PromptSafetyRisk;
};

const ALL_PHASES: PromptSafetyPolicyPhase[] = ["planning", "render", "quality", "repair", "promptSafety"];

const zh = (value: string) => value;

export const PROMPT_SAFETY_LEXICAL_REPLACEMENTS = [
  [zh("\u88ab\u57ce\u7ba1\u6253\u4f24"), zh("\u88ab\u7ba1\u7406\u5458\u4f24\u5230")],
  [zh("\u6267\u6cd5\u73b0\u573a"), zh("\u7ba1\u7406\u73b0\u573a")],
  [zh("\u8d76\u5979\u8d70"), zh("\u529d\u5979\u8d70")],
  [zh("\u6253\u4f24"), zh("\u4f24\u5230")],
  [zh("\u57ce\u7ba1"), zh("\u7ba1\u7406\u5458")],
] as const;

export const PROMPT_SAFETY_POLICY_RULES: PromptSafetyRule[] = [
  {
    id: "public_security_building",
    severity: "medium",
    pattern: /\u516c\u5b89\u5c40/gu,
    replacement: zh("\u57ce\u5e02\u529e\u6848\u5efa\u7b51"),
    reason: zh("\u771f\u5b9e\u673a\u6784\u8868\u8fbe\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "police_badge",
    severity: "high",
    pattern: /\u8b66\u5fbd/gu,
    replacement: zh("\u673a\u6784\u6807\u8bc6"),
    reason: zh("\u5fbd\u7ae0\u6807\u8bc6\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "national_emblem",
    severity: "high",
    pattern: /\u56fd\u5fbd/gu,
    replacement: zh("\u5efa\u7b51\u6b63\u95e8\u6807\u8bc6"),
    reason: zh("\u771f\u5b9e\u5fbd\u7ae0\u6807\u8bc6\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "blood_pool",
    severity: "high",
    pattern: /\u8840\u6cca/gu,
    replacement: zh("\u5730\u9762\u6df1\u8272\u6c34\u75d5"),
    reason: zh("\u8840\u8165\u89c6\u89c9\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "wound_closeup",
    severity: "high",
    pattern: /\u4f24\u53e3\u7279\u5199/gu,
    replacement: zh("\u53d7\u4f24\u75d5\u8ff9\u7684\u514b\u5236\u8fdc\u666f"),
    reason: zh("\u4f24\u53e3\u7279\u5199\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "real_uniform",
    severity: "medium",
    pattern: /\u771f\u5b9e\u8b66\u670d/gu,
    replacement: zh("\u6df1\u8272\u5236\u670d"),
    reason: zh("\u771f\u5b9e\u5236\u670d\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "political_figure",
    severity: "high",
    pattern: /\u771f\u5b9e\u653f\u6cbb\u4eba\u7269|\u653f\u6cbb\u4eba\u7269/gu,
    replacement: zh("\u516c\u5171\u4eba\u7269"),
    reason: zh("\u653f\u6cbb\u4eba\u7269\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "suicide",
    severity: "high",
    pattern: /\u81ea\u6740|\u4e0a\u540a/gu,
    negativePromptReplacement: zh("\u5177\u4f53\u81ea\u4f24\u884c\u4e3a"),
    reason: zh("\u9ad8\u5371\u81ea\u4f24\u8868\u8fbe"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "sexual_violence",
    severity: "high",
    pattern: /\u5f3a\u5978|\u6027\u4fb5/gu,
    negativePromptReplacement: zh("\u5177\u4f53\u6027\u66b4\u529b\u884c\u4e3a"),
    reason: zh("\u9ad8\u5371\u6027\u66b4\u529b\u8868\u8fbe"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "corpse",
    severity: "high",
    pattern: /\u5c38\u4f53/gu,
    negativePromptReplacement: zh("\u5177\u8c61\u9057\u4f53\u7ec6\u8282"),
    reason: zh("\u5c38\u4f53\u8868\u8fbe\u9700\u8981\u514b\u5236"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "public_security",
    severity: "medium",
    pattern: /\u516c\u5b89|\u8b66\u5bdf|\u8b66\u65b9/gu,
    replacement: zh("\u529e\u6848\u4eba\u5458"),
    reason: zh("\u673a\u6784\u6216\u6267\u6cd5\u8868\u8fbe\u9700\u8981\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "government",
    severity: "medium",
    pattern: /\u653f\u5e9c|\u653f\u6cbb/gu,
    replacement: zh("\u76f8\u5173\u673a\u6784"),
    reason: zh("\u653f\u6cbb\u673a\u6784\u8868\u8fbe\u9700\u8981\u6cdb\u5316"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "minor",
    severity: "medium",
    pattern: /\u672a\u6210\u5e74\u4eba|\u5c0f\u5b69|\u5b69\u5b50/gu,
    reason: zh("\u672a\u6210\u5e74\u4eba\u8bed\u5883\u9700\u8981\u8c28\u614e"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "injury",
    severity: "medium",
    pattern: /\u4f24\u53e3|\u8840\u8ff9|\u8840\u8165/gu,
    replacement: zh("\u53d7\u4f24\u75d5\u8ff9"),
    reason: zh("\u4f24\u5bb3\u8868\u8fbe\u9700\u8981\u514b\u5236"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "violence",
    severity: "medium",
    pattern: /\u51f6\u624b|\u6740|\u72af\u7f6a|\u66b4\u529b/gu,
    reason: zh("\u66b4\u529b\u6216\u72af\u7f6a\u8868\u8fbe\u9700\u8981\u514b\u5236"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "conflict",
    severity: "low",
    pattern: /\u51b2\u7a81|\u60ca\u609a|\u6050\u6016|\u5a01\u80c1|\u7d27\u5f20|\u60ac\u7591/gu,
    reason: zh("\u4f4e\u98ce\u9669\u60c5\u7eea\u8bcd"),
    appliesTo: ALL_PHASES,
  },
];

function isNegativePromptContext(context: PromptSafetyContext) {
  return /(^|\.)(fullNegativePrompt|negativePrompt)$/.test(context.path || "")
    || context.field === "negativePrompt"
    || context.field === "fullNegativePrompt";
}

const NEGATIVE_CONSTRAINT_PATTERN = /\u4e0d\u8981|\u907f\u514d|\u7981\u6b62|\u4e0d\u5c55\u793a|\u4e0d\u51fa\u73b0|\u4e0d\u5f97|\u675c\u7edd|\u53bb\u9664|\u62d2\u7edd/;
const NEGATED_FACT_PATTERN = /\u6ca1\u6709|\u672a\u89c1|\u5e76\u65e0|\u5e76\u6ca1\u6709|\u6392\u9664|\u4e0d\u5b58\u5728|\u672a\u53d1\u73b0|\u65e0\u6cd5\u8bc1\u5b9e/;

export function classifyPromptSafetyPath(path: string): PromptSafetyPathClass {
  const normalized = String(path || "").replace(/^result\./, "").replace(/\.value$/, "");
  if (/(^|\.)(fullNegativePrompt|negativePrompt)$/.test(normalized)) return "NEGATIVE_CONSTRAINT";
  if (/^storyboard\[\d+\]\.(sound|dialogue)$/.test(normalized)) return "EXECUTABLE_AUDIO_TEXT";
  if (/^storyboard\[\d+\]\.(scene|visual|shotType|composition|cameraMovement|lighting|emotion|transition|shotPurpose|firstFramePrompt|videoPrompt|lastFramePrompt)$/.test(normalized)) {
    return "EXECUTABLE_VISUAL";
  }
  if (/^workflow\.(fullVideoPrompt|concisePrompt)$/.test(normalized)) return "CANONICAL_EXECUTABLE";
  if (/^workflow\.(screenplay|filmScript)$/.test(normalized)) return "ARCHIVE_DERIVED";
  return "NARRATIVE_METADATA";
}

function clauseAroundMatch(text: string, index: number) {
  const boundaries = /[\n\r。！？；]/;
  let start = index;
  let end = index;
  while (start > 0 && !boundaries.test(text[start - 1])) start -= 1;
  while (end < text.length && !boundaries.test(text[end])) end += 1;
  return text.slice(start, end).trim();
}

function classifyPromptSafetyPolarity(
  text: string,
  index: number,
  pathClass: PromptSafetyPathClass,
): PromptSafetyPolarity {
  if (pathClass === "NEGATIVE_CONSTRAINT") return "negative_constraint";
  const clause = clauseAroundMatch(text, index);
  const localPrefix = clause.slice(0, Math.max(0, index - Math.max(0, text.lastIndexOf(clause))));
  const nearby = `${localPrefix}${clause}`.slice(-32);
  if (NEGATIVE_CONSTRAINT_PATTERN.test(nearby)) return "negative_constraint";
  if (NEGATED_FACT_PATTERN.test(nearby)) return "negated_fact";
  return "affirmative";
}

function decisionSeverityForMatch(
  rule: PromptSafetyRule,
  pathClass: PromptSafetyPathClass,
  polarity: PromptSafetyPolarity,
  replacement?: string,
): PromptSafetyDecisionSeverity {
  if (rule.severity === "low") return "warning";
  if (pathClass === "ARCHIVE_DERIVED") return "warning";
  if (pathClass === "NARRATIVE_METADATA") return polarity === "affirmative" ? "risk" : "warning";
  if (polarity !== "affirmative" || pathClass === "NEGATIVE_CONSTRAINT") return "risk";
  if (replacement) return "risk";
  return rule.severity === "high" ? "blocking" : "risk";
}

function normalizeSemanticClause(clause: string, match: string, polarity: PromptSafetyPolarity) {
  if (polarity !== "affirmative") return match.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return clause
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。；：、“”‘’（）()《》【】]/g, "")
    .toLowerCase();
}

function stableSafetyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ps_${(hash >>> 0).toString(36)}`;
}

function pathPriority(pathClass: PromptSafetyPathClass) {
  if (pathClass === "EXECUTABLE_VISUAL") return 0;
  if (pathClass === "EXECUTABLE_AUDIO_TEXT") return 1;
  if (pathClass === "CANONICAL_EXECUTABLE") return 2;
  if (pathClass === "NEGATIVE_CONSTRAINT") return 3;
  if (pathClass === "NARRATIVE_METADATA") return 4;
  return 5;
}

type RawSemanticFinding = Omit<PromptSafetySemanticFinding, "affectedPaths" | "affectedPathCount"> & { path: string };

function analyzeStringSafety(
  text: string,
  context: PromptSafetyContext,
  path: string,
): { text: string; findings: RawSemanticFinding[]; diffs: PromptSafetyDiff[] } {
  let next = text;
  const findings: RawSemanticFinding[] = [];
  const diffs: PromptSafetyDiff[] = [];
  for (const rule of PROMPT_SAFETY_POLICY_RULES) {
    if (!rule.appliesTo.includes(context.phase)) continue;
    rule.pattern.lastIndex = 0;
    const matches = Array.from(text.matchAll(rule.pattern));
    for (const match of matches) {
      const matchIndex = match.index || 0;
      const pathClass = classifyPromptSafetyPath(path);
      const polarity = classifyPromptSafetyPolarity(text, matchIndex, pathClass);
      const effective = effectivePolicyForMatch(rule, text, matchIndex, { ...context, path });
      const replacement = polarity === "negative_constraint"
        ? rule.negativePromptReplacement || effective.replacement
        : effective.replacement;
      const severity = decisionSeverityForMatch(rule, pathClass, polarity, replacement);
      const clause = clauseAroundMatch(text, matchIndex);
      const normalizedClause = normalizeSemanticClause(clause, match[0], polarity);
      const semanticGroup = `${rule.id}:${polarity === "affirmative" ? "affirmative" : "negative"}`;
      const fingerprint = stableSafetyHash([
        context.segmentIndex || 0,
        rule.id,
        normalizedClause,
        semanticGroup,
      ].join("|"));
      findings.push({
        fingerprint,
        ruleId: rule.id,
        severity,
        policySeverity: rule.severity,
        match: match[0],
        replacement,
        reason: effective.reason,
        normalizedClause,
        semanticGroup,
        pathClass,
        polarity,
        primaryPath: path,
        path,
        requiresCodexRepair: severity === "blocking",
      });
      if (replacement) {
        diffs.push({
          path,
          ruleId: rule.id,
          severity: rule.severity,
          before: text,
          after: text.replace(rule.pattern, replacement),
          phase: context.phase,
          reason: effective.reason,
        });
      }
    }
    if (matches.some((match) => {
      const polarity = classifyPromptSafetyPolarity(text, match.index || 0, classifyPromptSafetyPath(path));
      const effective = effectivePolicyForMatch(rule, text, match.index || 0, { ...context, path });
      return Boolean(polarity === "negative_constraint" ? rule.negativePromptReplacement || effective.replacement : effective.replacement);
    })) {
      rule.pattern.lastIndex = 0;
      next = next.replace(rule.pattern, (matched, ...args) => {
        const offset = Number(args[args.length - 2]) || 0;
        const polarity = classifyPromptSafetyPolarity(text, offset, classifyPromptSafetyPath(path));
        const effective = effectivePolicyForMatch(rule, text, offset, { ...context, path });
        return (polarity === "negative_constraint" ? rule.negativePromptReplacement || effective.replacement : effective.replacement) || matched;
      });
    }
  }
  return { text: next, findings, diffs };
}

export function deduplicatePromptSafetyFindings(findings: RawSemanticFinding[]): PromptSafetySemanticFinding[] {
  const grouped = new Map<string, RawSemanticFinding[]>();
  for (const finding of findings) {
    const current = grouped.get(finding.fingerprint) || [];
    current.push(finding);
    grouped.set(finding.fingerprint, current);
  }
  return Array.from(grouped.values()).map((items) => {
    const sorted = [...items].sort((left, right) => pathPriority(left.pathClass) - pathPriority(right.pathClass));
    const primary = sorted[0];
    const affectedPaths = Array.from(new Set(items.map((item) => item.path))).sort();
    const strongest = items.reduce((current, item) => {
      const rank = { warning: 0, risk: 1, blocking: 2 } as const;
      return rank[item.severity] > rank[current.severity] ? item : current;
    }, primary);
    const { path: _path, ...base } = primary;
    return {
      ...base,
      severity: strongest.severity,
      requiresCodexRepair: strongest.severity === "blocking",
      affectedPaths,
      affectedPathCount: affectedPaths.length,
    };
  });
}

export function analyzePromptSafetyTree<T>(
  value: T,
  options: PromptSafetyContext & { rootPath?: string },
): PromptSafetyTreeResult<T> {
  const rawFindings: RawSemanticFinding[] = [];
  const diffs: PromptSafetyDiff[] = [];
  function visit(item: unknown, path: string): unknown {
    if (typeof item === "string") {
      const analyzed = analyzeStringSafety(item, options, path);
      rawFindings.push(...analyzed.findings);
      diffs.push(...analyzed.diffs);
      return analyzed.text;
    }
    if (Array.isArray(item)) return item.map((entry, index) => visit(entry, `${path}[${index}]`));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => {
      const entryPath = options.rootPath && key === "value" && Object.keys(item as object).length === 1
        ? options.rootPath
        : path ? `${path}.${key}` : key;
      return [key, visit(entry, entryPath)];
    }));
  }
  const nextValue = visit(value, options.rootPath && !(value && typeof value === "object") ? options.rootPath : "") as T;
  const findings = deduplicatePromptSafetyFindings(rawFindings);
  const highestRisk = findings.some((finding) => finding.policySeverity === "high")
    ? "high"
    : findings.some((finding) => finding.policySeverity === "medium")
      ? "medium"
      : findings.length ? "low" : "none";
  return { value: nextValue, findings, diffs, highestRisk };
}

function hasNegativeInstructionContext(text: string, index: number) {
  const before = text.slice(Math.max(0, index - 12), index);
  const after = text.slice(index, Math.min(text.length, index + 20));
  return /\u4e0d\u8981|\u907f\u514d|\u7981\u6b62|\u4e0d\u5c55\u793a|\u4e0d\u51fa\u73b0|\u53bb\u9664|\u65e0|\u675c\u7edd/.test(`${before}${after}`);
}

function effectivePolicyForMatch(
  rule: PromptSafetyRule,
  text: string,
  index: number,
  context: PromptSafetyContext,
) {
  if (isNegativePromptContext(context) && rule.negativePromptReplacement && hasNegativeInstructionContext(text, index)) {
    return {
      severity: "medium" as PromptSafetyPolicySeverity,
      replacement: rule.negativePromptReplacement,
      reason: zh("\u8d1f\u5411\u63d0\u793a\u8bcd\u4e2d\u7684\u9ad8\u5371\u8868\u8fbe\u5df2\u62bd\u8c61\u5316"),
    };
  }
  return {
    severity: rule.severity,
    replacement: rule.replacement,
    reason: rule.reason,
  };
}

export function applyPromptSafetyPolicy(text: string, context: PromptSafetyContext) {
  let next = text;
  const findings: PromptSafetyPolicyFinding[] = [];

  for (const rule of PROMPT_SAFETY_POLICY_RULES) {
    if (!rule.appliesTo.includes(context.phase)) continue;
    rule.pattern.lastIndex = 0;
    const matches = Array.from(next.matchAll(rule.pattern));
    for (const match of matches) {
      const effective = effectivePolicyForMatch(rule, next, match.index || 0, context);
      findings.push({
        id: rule.id,
        severity: effective.severity,
        match: match[0],
        replacement: effective.replacement,
        reason: effective.reason,
        path: context.path,
        field: context.field,
      });
    }
    if (matches.some((match) => effectivePolicyForMatch(rule, next, match.index || 0, context).replacement)) {
      rule.pattern.lastIndex = 0;
      next = next.replace(rule.pattern, (match, ...args) => {
        const offset = Number(args[args.length - 2]) || 0;
        return effectivePolicyForMatch(rule, next, offset, context).replacement || match;
      });
    }
  }

  return { text: next, findings };
}

export function detectPromptSafetyRisk(text: string) {
  const findings = applyPromptSafetyPolicy(text, { phase: "quality" }).findings;
  const risk: PromptSafetyRisk = findings.some((finding) => finding.severity === "high")
    ? "high"
    : findings.some((finding) => finding.severity === "medium")
      ? "medium"
      : findings.some((finding) => finding.severity === "low")
        ? "low"
        : "none";
  return { risk, findings };
}

function rankPromptSafetyRisk(value: PromptSafetyRisk) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function riskFromPromptSafetySeverity(value: PromptSafetyPolicySeverity): PromptSafetyRisk {
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function mergePromptSafetyRisk(left: PromptSafetyRisk, right: PromptSafetyRisk): PromptSafetyRisk {
  return rankPromptSafetyRisk(right) > rankPromptSafetyRisk(left) ? right : left;
}

function fieldFromPromptSafetyPath(path: string) {
  const match = path.match(/(?:^|\.)([^.[\]]+)$/);
  return match ? match[1] : undefined;
}

function applyPromptSafetyPolicyDeepInternal(
  value: unknown,
  context: PromptSafetyContext,
  path: string,
  diffs: PromptSafetyDiff[],
): { value: unknown; highestRisk: PromptSafetyRisk } {
  if (typeof value === "string") {
    const policy = applyPromptSafetyPolicy(value, {
      ...context,
      path,
      field: context.field || fieldFromPromptSafetyPath(path),
    });
    const changed = policy.text !== value;
    if (changed) {
      for (const finding of policy.findings) {
        if (!finding.replacement) continue;
        diffs.push({
          path,
          ruleId: finding.id,
          severity: finding.severity,
          before: value,
          after: policy.text,
          phase: context.phase,
          reason: finding.reason,
        });
      }
    }
    const highestRisk = policy.findings.reduce<PromptSafetyRisk>(
      (risk, finding) => mergePromptSafetyRisk(risk, riskFromPromptSafetySeverity(finding.severity)),
      "none",
    );
    return { value: policy.text, highestRisk };
  }

  if (Array.isArray(value)) {
    let highestRisk: PromptSafetyRisk = "none";
    const next = value.map((item, index) => {
      const result = applyPromptSafetyPolicyDeepInternal(item, context, `${path}[${index}]`, diffs);
      highestRisk = mergePromptSafetyRisk(highestRisk, result.highestRisk);
      return result.value;
    });
    return { value: next, highestRisk };
  }

  if (value && typeof value === "object") {
    let highestRisk: PromptSafetyRisk = "none";
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const itemPath = path ? `${path}.${key}` : key;
      const result = applyPromptSafetyPolicyDeepInternal(item, context, itemPath, diffs);
      highestRisk = mergePromptSafetyRisk(highestRisk, result.highestRisk);
      next[key] = result.value;
    }
    return { value: next, highestRisk };
  }

  return { value, highestRisk: "none" };
}

export function applyPromptSafetyPolicyDeep<T>(
  value: T,
  context: PromptSafetyContext,
): PromptSafetyPrepassResult<T> {
  const safetyDiffs: PromptSafetyDiff[] = [];
  const result = applyPromptSafetyPolicyDeepInternal(value, context, context.path || "", safetyDiffs);
  return {
    sourceTextOriginal: value,
    sourceTextForModel: result.value as T,
    safetyDiffs,
    highestRisk: result.highestRisk,
  };
}

export function summarizePromptSafetyFindings(findings: PromptSafetyPolicyFinding[]) {
  return findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    match: finding.match,
    replacement: finding.replacement,
    reason: finding.reason,
    path: finding.path,
    field: finding.field,
  }));
}
