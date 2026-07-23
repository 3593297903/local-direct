import {
  compileSegmentContractForPrompt,
  type CompiledSegmentContractBlock,
} from "./codex-prompt-input-compiler";
import {
  buildRenderPacks,
  type RenderPackSchedule,
  type RenderScheduleSegment,
} from "./batch-render-scheduler";
import type { SegmentContract } from "./batch-segment-contract";

export type ContractPreflightMetrics = {
  attempts: number;
  ready: number;
  compacted: number;
  isolated: number;
  invalid: number;
  overflow: number;
};

export type SegmentContractPreflight = {
  segmentIndex: number;
  sourceHash: string;
  contractHash: string;
  compile: CompiledSegmentContractBlock;
  disposition: "ready" | "isolated" | "invalid";
  reasonCode:
    | "CONTRACT_PREFLIGHT_READY"
    | "CONTRACT_PREFLIGHT_COMPACTED"
    | "CONTRACT_PREFLIGHT_ISOLATED"
    | "CONTRACT_BUDGET_EXCEEDED"
    | "CONTRACT_HASH_INVALID"
    | "CONTRACT_SCHEMA_INVALID";
};

export type SegmentContractPreflightEntry<T> = {
  item: T;
  preflight: SegmentContractPreflight;
};

export type RenderContractPreflightPlan<T> = {
  eligibleRuns: Array<Array<SegmentContractPreflightEntry<T>>>;
  isolated: Array<SegmentContractPreflightEntry<T>>;
  invalid: Array<SegmentContractPreflightEntry<T>>;
  metrics: ContractPreflightMetrics;
};

export type ContractPreflightOptions<T> = {
  getSegmentIndex: (item: T) => number;
  getSourceText: (item: T) => string;
  getContract: (item: T) => SegmentContract;
  getScheduleSegment: (entry: SegmentContractPreflightEntry<T>) => RenderScheduleSegment;
  shouldIsolate?: (item: T, preflight: SegmentContractPreflight) => boolean;
};

export type PreflightedRenderPack<T> = {
  kind: "render_pack";
  isolated: boolean;
  repair: false;
  singleGeneration: false;
  profile: RenderPackSchedule<SegmentContractPreflightEntry<T>>["profile"];
  concurrency: number;
  packSize: number;
  riskScore: number;
  reasons: string[];
  entries: Array<SegmentContractPreflightEntry<T>>;
};

export type PreflightedRenderSchedule<T> = {
  packs: Array<PreflightedRenderPack<T>>;
  concurrency: number;
  invalid: Array<SegmentContractPreflightEntry<T>>;
  metrics: ContractPreflightMetrics;
};

export type ContractPreflightAuthoritativeRejection = {
  affectedSegmentIndexes: number[];
  errorCode: string;
  rerouteGeneration: number;
};

export type ContractPreflightRejectionPartition<T> =
  | {
      disposition: "reroute";
      rejectedEntries: Array<SegmentContractPreflightEntry<T>>;
      retryRuns: Array<Array<SegmentContractPreflightEntry<T>>>;
      nextGeneration: number;
      reasonCode: string;
    }
  | {
      disposition: "fail_closed";
      rejectedEntries: [];
      retryRuns: [];
      nextGeneration: number;
      reasonCode: string;
    };

export function preflightSegmentContracts<T>(
  items: T[],
  options: ContractPreflightOptions<T>,
): RenderContractPreflightPlan<T> {
  const eligibleRuns: Array<Array<SegmentContractPreflightEntry<T>>> = [];
  const isolated: Array<SegmentContractPreflightEntry<T>> = [];
  const invalid: Array<SegmentContractPreflightEntry<T>> = [];
  const metrics: ContractPreflightMetrics = {
    attempts: 0,
    ready: 0,
    compacted: 0,
    isolated: 0,
    invalid: 0,
    overflow: 0,
  };
  let currentRun: Array<SegmentContractPreflightEntry<T>> = [];

  const flushRun = () => {
    if (currentRun.length) eligibleRuns.push(currentRun);
    currentRun = [];
  };

  for (const item of items) {
    metrics.attempts += 1;
    const expectedIndex = options.getSegmentIndex(item);
    const sourceText = normalizeLineEndings(options.getSourceText(item));
    const contract = options.getContract(item);
    let compile = compileSegmentContractForPrompt(contract);

    if (
      compile.status !== "invalid"
      && (compile.segmentIndex !== expectedIndex || normalizeLineEndings(contract.sourceText) !== sourceText)
    ) {
      compile = {
        status: "invalid",
        compilerVersion: compile.compilerVersion,
        segmentIndex: expectedIndex,
        contractHash: contract.contractHash,
        errorCode: "CONTRACT_SCHEMA_INVALID",
        message: "SegmentContract identity does not match its render input",
      };
    }

    const base: SegmentContractPreflight = {
      segmentIndex: expectedIndex,
      sourceHash: String(contract?.sourceHash || ""),
      contractHash: String(contract?.contractHash || compile.contractHash || ""),
      compile,
      disposition: "invalid",
      reasonCode: "CONTRACT_SCHEMA_INVALID",
    };

    if (compile.status === "invalid") {
      flushRun();
      metrics.invalid += 1;
      invalid.push({
        item,
        preflight: {
          ...base,
          reasonCode: compile.errorCode,
        },
      });
      continue;
    }

    if (compile.status === "overflow") {
      flushRun();
      metrics.invalid += 1;
      metrics.overflow += 1;
      invalid.push({
        item,
        preflight: {
          ...base,
          reasonCode: compile.errorCode,
        },
      });
      continue;
    }

    const readyPreflight: SegmentContractPreflight = {
      ...base,
      compile,
      disposition: "ready",
      reasonCode: compile.status === "compacted"
        ? "CONTRACT_PREFLIGHT_COMPACTED"
        : "CONTRACT_PREFLIGHT_READY",
    };
    if (compile.status === "compacted") metrics.compacted += 1;
    else metrics.ready += 1;

    if (options.shouldIsolate?.(item, readyPreflight)) {
      flushRun();
      metrics.isolated += 1;
      isolated.push({
        item,
        preflight: {
          ...readyPreflight,
          disposition: "isolated",
          reasonCode: "CONTRACT_PREFLIGHT_ISOLATED",
        },
      });
      continue;
    }

    currentRun.push({ item, preflight: readyPreflight });
  }

  flushRun();
  return { eligibleRuns, isolated, invalid, metrics };
}

export function buildPreflightedRenderPacks<T>(
  plan: RenderContractPreflightPlan<T>,
  options: ContractPreflightOptions<T>,
): PreflightedRenderSchedule<T> {
  const packs: Array<PreflightedRenderPack<T>> = [];

  for (const run of plan.eligibleRuns) {
    const schedule = buildRenderPacks(run, { getSegment: options.getScheduleSegment });
    for (const entries of schedule.packs) {
      packs.push(toPreflightedPack(entries, schedule, false));
    }
  }

  for (const entry of plan.isolated) {
    const schedule = buildRenderPacks([entry], {
      forceProfile: "SINGLE",
      getSegment: options.getScheduleSegment,
    });
    packs.push(toPreflightedPack([entry], schedule, true));
  }

  packs.sort((left, right) => left.entries[0].preflight.segmentIndex - right.entries[0].preflight.segmentIndex);
  return {
    packs,
    concurrency: Math.min(4, Math.max(0, ...packs.map((pack) => pack.concurrency))),
    invalid: plan.invalid,
    metrics: { ...plan.metrics },
  };
}

export function partitionPreflightedRenderPackAfterRejection<T>(
  pack: PreflightedRenderPack<T>,
  rejection: ContractPreflightAuthoritativeRejection,
): ContractPreflightRejectionPartition<T> {
  const entries = Array.isArray(pack?.entries) ? pack.entries : [];
  const entryIndexes = entries.map((entry) => Number(entry?.preflight?.segmentIndex));
  const affectedIndexes = Array.isArray(rejection?.affectedSegmentIndexes)
    ? rejection.affectedSegmentIndexes.map(Number)
    : [];
  const failClosed = (reasonCode: string): ContractPreflightRejectionPartition<T> => ({
    disposition: "fail_closed",
    rejectedEntries: [],
    retryRuns: [],
    nextGeneration: Number.isInteger(rejection?.rerouteGeneration)
      ? rejection.rerouteGeneration
      : 0,
    reasonCode,
  });

  if (
    rejection?.errorCode === "CONTRACT_PREFLIGHT_V2_CREATE_PAUSED"
    || rejection?.rerouteGeneration !== 0
  ) {
    return failClosed(String(rejection?.errorCode || "CONTRACT_PREFLIGHT_REJECTION_INVALID"));
  }
  if (
    !entries.length
    || entryIndexes.some((index) => !Number.isInteger(index) || index < 1)
    || new Set(entryIndexes).size !== entryIndexes.length
    || affectedIndexes.length === 0
    || affectedIndexes.some((index) => !Number.isInteger(index) || index < 1)
    || new Set(affectedIndexes).size !== affectedIndexes.length
  ) {
    return failClosed("CONTRACT_PREFLIGHT_REJECTION_INVALID");
  }

  const entryIndexSet = new Set(entryIndexes);
  if (affectedIndexes.some((index) => !entryIndexSet.has(index))) {
    return failClosed("CONTRACT_PREFLIGHT_REJECTION_INVALID");
  }
  if (entries.some((entry) => (
    !["ready", "isolated"].includes(entry.preflight.disposition)
    || ["invalid", "overflow"].includes(entry.preflight.compile.status)
  ))) {
    return failClosed("CONTRACT_PREFLIGHT_REJECTION_INVALID");
  }

  const affected = new Set(affectedIndexes);
  const rejectedEntries = entries.filter((entry) => affected.has(entry.preflight.segmentIndex));
  const retryRuns: Array<Array<SegmentContractPreflightEntry<T>>> = [];
  let currentRun: Array<SegmentContractPreflightEntry<T>> = [];
  let previousIndex: number | null = null;

  const flushRun = () => {
    if (currentRun.length) retryRuns.push(currentRun);
    currentRun = [];
    previousIndex = null;
  };

  for (const entry of entries) {
    const segmentIndex = entry.preflight.segmentIndex;
    if (affected.has(segmentIndex)) {
      flushRun();
      continue;
    }
    if (previousIndex !== null && segmentIndex !== previousIndex + 1) flushRun();
    currentRun.push(entry);
    previousIndex = segmentIndex;
  }
  flushRun();

  return {
    disposition: "reroute",
    rejectedEntries,
    retryRuns,
    nextGeneration: 1,
    reasonCode: String(rejection.errorCode || "CONTRACT_PREFLIGHT_REJECTED"),
  };
}

function toPreflightedPack<T>(
  entries: Array<SegmentContractPreflightEntry<T>>,
  schedule: RenderPackSchedule<SegmentContractPreflightEntry<T>>,
  isolated: boolean,
): PreflightedRenderPack<T> {
  return {
    kind: "render_pack",
    isolated,
    repair: false,
    singleGeneration: false,
    profile: schedule.profile,
    concurrency: Math.min(4, schedule.concurrency),
    packSize: schedule.packSize,
    riskScore: schedule.riskScore,
    reasons: [...schedule.reasons],
    entries,
  };
}

function normalizeLineEndings(value: unknown) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}
