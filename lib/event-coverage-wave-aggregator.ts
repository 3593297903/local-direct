import {
  createEventCoverageCodexJob,
  type EventCoverageCodexJob,
  type EventCoverageJudgeCase,
} from "./event-coverage-codex-queue";
import { buildBatchSegmentResultHash } from "./batch-segment-repair-patch";

type WaveWaiter = {
  resolve: (job: EventCoverageCodexJob) => void;
  reject: (error: unknown) => void;
};

type WaveBucket = {
  key: string;
  batchId: string;
  renderRound: string;
  cases: Map<string, EventCoverageJudgeCase>;
  waiters: WaveWaiter[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
};

type AggregatorState = { buckets: Map<string, WaveBucket> };

const MAX_WAVE_SEGMENTS = 8;
const MAX_WAVE_CASES = 20;
const DEFAULT_WINDOW_MS = 400;
const stateKey = Symbol.for("localdirector.eventCoverageWaveAggregator");

function state() {
  const host = globalThis as typeof globalThis & { [stateKey]?: AggregatorState };
  if (!host[stateKey]) host[stateKey] = { buckets: new Map() };
  return host[stateKey]!;
}

export function enqueueEventCoverageJudgeWave(input: {
  batchId: string;
  renderRound: string | number;
  cases: EventCoverageJudgeCase[];
  aggregationWindowMs?: number;
}) {
  if (!input.cases.length || input.cases.length > MAX_WAVE_CASES) {
    throw new Error(`Judge wave request must contain 1-${MAX_WAVE_CASES} cases`);
  }
  const segmentCount = new Set(input.cases.map((item) => item.segmentIndex)).size;
  if (segmentCount > MAX_WAVE_SEGMENTS) throw new Error(`Judge wave request exceeds ${MAX_WAVE_SEGMENTS} segments`);

  const batchId = String(input.batchId || "").trim();
  const renderRound = String(input.renderRound || "default").trim();
  if (!batchId || !renderRound) throw new Error("Judge wave batchId/renderRound is required");
  const key = `${batchId}:${renderRound}`;
  const aggregator = state();
  let bucket = aggregator.buckets.get(key);
  if (bucket && !canFit(bucket, input.cases)) {
    void flushBucket(bucket);
    bucket = undefined;
  }
  if (!bucket) {
    bucket = {
      key,
      batchId,
      renderRound,
      cases: new Map(),
      waiters: [],
      timer: null,
      flushing: false,
    };
    aggregator.buckets.set(key, bucket);
  }

  for (const judgeCase of input.cases) {
    bucket.cases.set(caseKey(judgeCase), judgeCase);
  }

  const result = new Promise<EventCoverageCodexJob>((resolve, reject) => {
    bucket!.waiters.push({ resolve, reject });
  });
  const windowMs = Math.max(300, Math.min(500, input.aggregationWindowMs || DEFAULT_WINDOW_MS));
  if (!bucket.timer) bucket.timer = setTimeout(() => void flushBucket(bucket!), windowMs);
  if (isFull(bucket)) void flushBucket(bucket);
  return result;
}

async function flushBucket(bucket: WaveBucket) {
  if (bucket.flushing) return;
  bucket.flushing = true;
  if (bucket.timer) clearTimeout(bucket.timer);
  state().buckets.delete(bucket.key);
  const cases = [...bucket.cases.values()].sort((left, right) => (
    left.segmentIndex - right.segmentIndex || left.slotId.localeCompare(right.slotId)
  ));
  const waveId = `wave-${bucket.renderRound}-${buildBatchSegmentResultHash(
    cases.map((item) => [item.segmentIndex, item.slotId, item.contractHash, item.resultHash]),
  )}`;
  try {
    const job = await createEventCoverageCodexJob({ batchId: bucket.batchId, waveId, cases });
    for (const waiter of bucket.waiters) waiter.resolve(job);
  } catch (error) {
    for (const waiter of bucket.waiters) waiter.reject(error);
  }
}

function canFit(bucket: WaveBucket, incoming: EventCoverageJudgeCase[]) {
  const combined = new Map(bucket.cases);
  for (const judgeCase of incoming) combined.set(caseKey(judgeCase), judgeCase);
  return combined.size <= MAX_WAVE_CASES
    && new Set([...combined.values()].map((item) => item.segmentIndex)).size <= MAX_WAVE_SEGMENTS;
}

function isFull(bucket: WaveBucket) {
  return bucket.cases.size >= MAX_WAVE_CASES
    || new Set([...bucket.cases.values()].map((item) => item.segmentIndex)).size >= MAX_WAVE_SEGMENTS;
}

function caseKey(judgeCase: EventCoverageJudgeCase) {
  return `${judgeCase.segmentIndex}:${judgeCase.slotId}`;
}

export function resetEventCoverageWaveAggregatorForTests() {
  for (const bucket of state().buckets.values()) {
    if (bucket.timer) clearTimeout(bucket.timer);
  }
  state().buckets.clear();
}
