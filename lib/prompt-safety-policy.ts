export type PromptSafetyPolicyPhase = "planning" | "render" | "quality" | "repair" | "promptSafety";

export type PromptSafetyPolicySeverity = "high" | "medium" | "low";

export type PromptSafetyContext = {
  phase: PromptSafetyPolicyPhase;
  path?: string;
  field?: string;
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
    reason: zh("\u9ad8\u5371\u81ea\u4f24\u8868\u8fbe"),
    appliesTo: ALL_PHASES,
  },
  {
    id: "sexual_violence",
    severity: "high",
    pattern: /\u5f3a\u5978|\u6027\u4fb5/gu,
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
