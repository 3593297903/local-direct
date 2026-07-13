export type BatchInvocationKind =
  | "season_pack"
  | "render_pack"
  | "single_generation"
  | "path_repair"
  | "coverage_judge"
  | "safety_rewrite"
  | "contract_correction";

export type BatchInvocationPhase =
  | "planned"
  | "created"
  | "claimed"
  | "executing"
  | "completed"
  | "failed";

export type BatchInvocationEvent = {
  eventId: string;
  batchId: string;
  segmentIndexes: number[];
  kind: BatchInvocationKind;
  phase: BatchInvocationPhase;
  jobId?: string;
  reasonCode?: string;
  createdAt: string;
};

export type BatchInvocationCounters = Record<BatchInvocationKind, {
  planned: number;
  created: number;
  executing: number;
  completed: number;
  failed: number;
}>;

export type BatchInvocationObserver = (event: BatchInvocationEvent) => void;

const INVOCATION_KINDS: BatchInvocationKind[] = [
  "season_pack",
  "render_pack",
  "single_generation",
  "path_repair",
  "coverage_judge",
  "safety_rewrite",
  "contract_correction",
];

const observers = new Set<BatchInvocationObserver>();

export function installBatchInvocationObserver(observer: BatchInvocationObserver) {
  observers.add(observer);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    observers.delete(observer);
  };
}

export function recordBatchInvocation(event: BatchInvocationEvent) {
  if (!observers.size) return;
  for (const observer of observers) observer(event);
}

export function createEmptyBatchInvocationCounters(): BatchInvocationCounters {
  return Object.fromEntries(INVOCATION_KINDS.map((kind) => [kind, {
    planned: 0,
    created: 0,
    executing: 0,
    completed: 0,
    failed: 0,
  }])) as BatchInvocationCounters;
}

export function summarizeBatchInvocations(events: readonly BatchInvocationEvent[]): BatchInvocationCounters {
  const counters = createEmptyBatchInvocationCounters();
  for (const event of events) {
    const counter = counters[event.kind];
    if (!counter || event.phase === "claimed") continue;
    counter[event.phase] += 1;
  }
  return counters;
}
