import type { RenderOperationRefV2 } from "./batch-render-operation";

export type RenderObservationMode = "foreground" | "background";

export type RenderObservationErrorClass =
  | "transient"
  | "confirmed_missing"
  | "identity_invalid"
  | "terminal_job_failure"
  | "aborted";

export type RenderObservationOutcome<TJob> =
  | { status: "completed"; job: TJob }
  | { status: "terminal_failed"; jobId: string; reasonCode: string; job?: TJob }
  | { status: "detached"; jobId: string; reasonCode: string }
  | { status: "aborted"; jobId: string };

type RenderJobStatus = {
  id?: string;
  status?: string;
  stage?: string;
};

type ObserverRegistry<T> = {
  observe(jobId: string, factory: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

export function isBatchRenderLateReconciliationEnabled(value: string | undefined) {
  return value !== "0";
}

export function classifyRenderObservationError(error: unknown): RenderObservationErrorClass {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(record.status || record.statusCode || 0);
  const code = String(record.code || "").toUpperCase();
  const name = String(record.name || "");
  if (name === "AbortError" || code === "ABORT_ERR") return "aborted";
  if (status === 404) return "confirmed_missing";
  if (
    error instanceof TypeError
    || [408, 425, 429].includes(status)
    || status >= 500
    || ["JOB_STORAGE_BUSY", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(code)
  ) {
    return "transient";
  }
  if (/IDENTITY|MANIFEST|PROTOCOL|SCHEMA/.test(code)) return "identity_invalid";
  if (/TERMINAL|JOB_FAILED/.test(code)) return "terminal_job_failure";
  return "identity_invalid";
}

export async function observeRenderPackJob<TJob extends RenderJobStatus>(input: {
  jobId: string;
  mode: RenderObservationMode;
  readJob: (jobId: string, signal?: AbortSignal) => Promise<TJob>;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  attentionMs?: number;
  now?: () => number;
  pollDelay?: (input: { stage: string; transientFailures: number }) => number;
  isHidden?: () => boolean;
  random?: () => number;
  signal?: AbortSignal;
  confirmedMissingProbes?: number;
  onStage?: (job: TJob) => void;
}): Promise<RenderObservationOutcome<TJob>> {
  const now = input.now || Date.now;
  const startedAt = now();
  const attentionMs = Math.max(0, input.attentionMs ?? 30 * 60_000);
  const requiredMissingProbes = Math.max(2, input.confirmedMissingProbes ?? 3);
  let transientFailures = 0;
  let missingProbes = 0;
  let stage = "pending";

  while (true) {
    if (input.signal?.aborted) return { status: "aborted", jobId: input.jobId };
    if (input.mode === "foreground" && now() - startedAt >= attentionMs) {
      return { status: "detached", jobId: input.jobId, reasonCode: "RENDER_ATTENTION_EXPIRED" };
    }

    try {
      const job = await input.readJob(input.jobId, input.signal);
      transientFailures = 0;
      missingProbes = 0;
      stage = String(job.stage || job.status || "pending");
      input.onStage?.(job);
      if (job.status === "completed") return { status: "completed", job };
      if (job.status === "failed") {
        return {
          status: "terminal_failed",
          jobId: input.jobId,
          reasonCode: "RENDER_JOB_TERMINAL_FAILURE",
          job,
        };
      }
    } catch (error) {
      const errorClass = classifyRenderObservationError(error);
      if (errorClass === "aborted" || input.signal?.aborted) {
        return { status: "aborted", jobId: input.jobId };
      }
      if (errorClass === "confirmed_missing") {
        missingProbes += 1;
        if (missingProbes >= requiredMissingProbes) {
          return {
            status: "terminal_failed",
            jobId: input.jobId,
            reasonCode: "RENDER_JOB_CONFIRMED_MISSING",
          };
        }
      } else if (errorClass === "transient") {
        transientFailures += 1;
        missingProbes = 0;
      } else {
        return {
          status: "terminal_failed",
          jobId: input.jobId,
          reasonCode: errorClass === "terminal_job_failure"
            ? "RENDER_JOB_TERMINAL_FAILURE"
            : "RENDER_JOB_IDENTITY_INVALID",
        };
      }
    }

    const delayMs = Math.max(0, input.pollDelay?.({ stage, transientFailures })
      ?? calculateRenderObservationDelay({
        stage,
        transientFailures,
        hidden: input.isHidden?.() === true,
        random: input.random,
      }));
    try {
      await input.sleep(delayMs, input.signal);
    } catch (error) {
      if (classifyRenderObservationError(error) === "aborted" || input.signal?.aborted) {
        return { status: "aborted", jobId: input.jobId };
      }
      throw error;
    }
  }
}

export function startConcurrentRenderRecoveryObservers<TJob, TOutcome>(input: {
  operations: RenderOperationRefV2[];
  registry: ObserverRegistry<TOutcome>;
  observe: (operation: RenderOperationRefV2, signal: AbortSignal) => Promise<TOutcome>;
  onOutcome?: (operation: RenderOperationRefV2, outcome: TOutcome) => void | Promise<void>;
}) {
  const seen = new Set<string>();
  const observers: Array<{ jobId: string; promise: Promise<TOutcome> }> = [];
  for (const operation of input.operations) {
    const jobId = String(operation.jobId || "");
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    const promise = input.registry.observe(jobId, async (signal) => {
      const outcome = await input.observe(operation, signal);
      await input.onOutcome?.(operation, outcome);
      return outcome;
    });
    observers.push({ jobId, promise });
  }
  return {
    observers,
    settled: Promise.allSettled(observers.map((observer) => observer.promise)),
  };
}

export async function retryCreatingRenderOperation<TValue>(input: {
  operation: RenderOperationRefV2;
  create: (operation: RenderOperationRefV2) => Promise<TValue>;
  sleep: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<
  | { status: "created"; value: TValue; attempts: number }
  | { status: "transient"; errorCode: string; attempts: number }
  | { status: "terminal_failed"; errorCode: string; attempts: number }
> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { status: "created", value: await input.create(input.operation), attempts: attempt };
    } catch (error) {
      const errorClass = classifyRenderObservationError(error);
      if (errorClass !== "transient") {
        return {
          status: "terminal_failed",
          errorCode: errorClass === "confirmed_missing"
            ? "RENDER_CREATE_IDENTITY_INVALID"
            : "RENDER_CREATE_TERMINAL_FAILURE",
          attempts: attempt,
        };
      }
      if (attempt === maxAttempts) {
        return { status: "transient", errorCode: "RENDER_CREATE_TRANSIENT", attempts: attempt };
      }
      await input.sleep(Math.min(5_000, 250 * (2 ** (attempt - 1))));
    }
  }
  return { status: "transient", errorCode: "RENDER_CREATE_TRANSIENT", attempts: maxAttempts };
}

export function calculateRenderObservationDelay(input: {
  stage: string;
  transientFailures: number;
  hidden: boolean;
  random?: () => number;
}) {
  const base = input.transientFailures > 0
    ? Math.min(30_000, 2_500 * (2 ** Math.min(input.transientFailures - 1, 4)))
    : /executing|finalizing|running|completed/i.test(input.stage) ? 2_500 : 5_000;
  const visibilityAdjusted = input.hidden ? Math.min(30_000, base * 2) : base;
  const random = Math.min(1, Math.max(0, (input.random || Math.random)()));
  const jittered = visibilityAdjusted * (0.9 + random * 0.2);
  return Math.min(30_000, Math.max(250, Math.round(jittered)));
}
