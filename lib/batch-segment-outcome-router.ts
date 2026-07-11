import type {
  BatchSegmentQualityFinding,
  BatchSegmentQualityGate,
} from "./batch-segment-quality-gate";
import { isAllowedBatchSegmentRepairPath } from "./batch-segment-repair-patch";

export type BatchEventCoverageStage =
  | "shadow"
  | "local"
  | "judge-shadow"
  | "judge-active"
  | "patch-active";

export type BatchSegmentOutcomeAction =
  | "accept"
  | "request_quality_patch"
  | "enqueue_judge_shadow"
  | "enqueue_judge"
  | "request_event_patch"
  | "regenerate_segment"
  | "needs_review";

export type BatchSegmentOutcomeRoute = {
  action: BatchSegmentOutcomeAction;
  repairFindings: BatchSegmentQualityFinding[];
  ambiguousFindings: BatchSegmentQualityFinding[];
  confirmedEventFindings: BatchSegmentQualityFinding[];
  structuralFindings: BatchSegmentQualityFinding[];
  deferredFindings: BatchSegmentQualityFinding[];
};

const AMBIGUOUS_EVENT_CODES = new Set(["ambiguous_required_event_slot"]);
const CONFIRMED_EVENT_CODES = new Set([
  "missing_required_event_slot",
  "continuity_contradiction",
]);

export function routeBatchSegmentOutcome(input: {
  gate: BatchSegmentQualityGate;
  hasUsableResult: boolean;
  coverageStage: BatchEventCoverageStage;
}): BatchSegmentOutcomeRoute {
  const blocking = input.gate.blockingFindings;
  const ambiguousFindings = blocking.filter((finding) => AMBIGUOUS_EVENT_CODES.has(finding.code));
  const confirmedEventFindings = blocking.filter((finding) => CONFIRMED_EVENT_CODES.has(finding.code));
  const eventFindings = new Set([...ambiguousFindings, ...confirmedEventFindings]);
  const repairFindings = blocking.filter((finding) => (
    !eventFindings.has(finding)
    && Boolean(finding.path)
    && isAllowedBatchSegmentRepairPath(finding.path || "")
  ));
  const repairFindingSet = new Set(repairFindings);
  const structuralFindings = blocking.filter((finding) => (
    !eventFindings.has(finding) && !repairFindingSet.has(finding)
  ));

  if (!input.hasUsableResult) {
    return buildRoute("regenerate_segment", {
      repairFindings,
      ambiguousFindings,
      confirmedEventFindings,
      structuralFindings,
      deferredFindings: blocking,
    });
  }

  if (structuralFindings.length) {
    return buildRoute("regenerate_segment", {
      repairFindings: [],
      ambiguousFindings,
      confirmedEventFindings,
      structuralFindings,
      deferredFindings: [...repairFindings, ...ambiguousFindings, ...confirmedEventFindings],
    });
  }

  // Quality fields are repaired first. Event findings are deliberately deferred
  // so an ambiguous event can never become an authorized repair path.
  if (repairFindings.length) {
    return buildRoute("request_quality_patch", {
      repairFindings,
      ambiguousFindings,
      confirmedEventFindings,
      structuralFindings,
      deferredFindings: [...ambiguousFindings, ...confirmedEventFindings],
    });
  }

  if (confirmedEventFindings.length) {
    return buildRoute(input.coverageStage === "patch-active" ? "request_event_patch" : "needs_review", {
      repairFindings: input.coverageStage === "patch-active" ? confirmedEventFindings : [],
      ambiguousFindings,
      confirmedEventFindings,
      structuralFindings,
      deferredFindings: input.coverageStage === "patch-active" ? ambiguousFindings : blocking,
    });
  }

  if (ambiguousFindings.length) {
    const action: BatchSegmentOutcomeAction = input.coverageStage === "judge-shadow"
      ? "enqueue_judge_shadow"
      : input.coverageStage === "judge-active" || input.coverageStage === "patch-active"
        ? "enqueue_judge"
        : input.coverageStage === "shadow"
          ? "accept"
          : "needs_review";
    return buildRoute(action, {
      repairFindings: [],
      ambiguousFindings,
      confirmedEventFindings,
      structuralFindings,
      deferredFindings: action === "accept" ? [] : ambiguousFindings,
    });
  }

  return buildRoute("accept", {
    repairFindings: [],
    ambiguousFindings: [],
    confirmedEventFindings: [],
    structuralFindings: [],
    deferredFindings: [],
  });
}

function buildRoute(
  action: BatchSegmentOutcomeAction,
  findings: Omit<BatchSegmentOutcomeRoute, "action">,
): BatchSegmentOutcomeRoute {
  return { action, ...findings };
}
