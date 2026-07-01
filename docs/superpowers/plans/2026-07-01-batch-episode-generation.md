# Batch Episode Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workbench episode-count selector and a local batch episode generation flow that can generate up to 30 saved, memory-linked project episodes.

**Architecture:** Keep the existing single-episode generation path unchanged for count `1`. For count `2-30`, create a file-backed `EpisodeBatchJob`, process it through a local worker, generate episodes sequentially through the existing `/api/video-prompt/jobs` and `/api/projects` paths, and refresh project memory between each saved episode.

**Tech Stack:** Next.js API routes, React client state, TypeScript file queues, local Node worker scripts, existing Nest project persistence and director context APIs.

---

## File Map

- Create `lib/episode-batch-queue.ts`: owns batch job validation, JSON persistence, status transitions, append-version tracking, cancel/retry helpers, and root path resolution.
- Create `app/api/episode-batch/jobs/route.ts`: creates a batch job.
- Create `app/api/episode-batch/jobs/[jobId]/route.ts`: returns a batch job.
- Create `app/api/episode-batch/jobs/claim/route.ts`: worker-only claim endpoint.
- Create `app/api/episode-batch/jobs/[jobId]/complete/route.ts`: worker-only complete endpoint.
- Create `app/api/episode-batch/jobs/[jobId]/fail/route.ts`: worker-only partial failure endpoint.
- Create `app/api/episode-batch/jobs/[jobId]/cancel/route.ts`: user-facing cancel endpoint.
- Create `app/api/episode-batch/jobs/[jobId]/retry/route.ts`: user-facing retry endpoint.
- Create `scripts/episode-batch-worker.mjs`: polls batch jobs and processes episodes sequentially.
- Modify `package.json`: add `episode-batch:worker`.
- Modify `components/DashboardClient.tsx`: add episode count control, create/poll batch jobs, show progress, keep single-episode path intact.
- Add tests:
  - `test/episode-batch-queue.test.mjs`
  - `test/episode-batch-api.test.mjs`
  - `test/episode-batch-worker.test.mjs`
  - `test/episode-batch-dashboard.test.mjs`

## Task 1: Queue Contract And Tests

**Files:**
- Create: `test/episode-batch-queue.test.mjs`
- Create: `lib/episode-batch-queue.ts`

- [ ] **Step 1: Write failing queue tests**

Create `test/episode-batch-queue.test.mjs` with these behaviors:

```js
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});
const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");

const {
  appendEpisodeBatchVersion,
  cancelEpisodeBatchJob,
  claimNextEpisodeBatchJob,
  completeEpisodeBatchJob,
  createEpisodeBatchJob,
  failEpisodeBatchJob,
  getEpisodeBatchJob,
  retryEpisodeBatchJob,
} = require("../lib/episode-batch-queue.ts");

function makeTempRoot() {
  return path.join(os.tmpdir(), `localdirector-episode-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("creates and claims an episode batch job with a 30 episode limit", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createEpisodeBatchJob({
      script: "一部关于未来车站的短剧，总共生成三集。",
      episodeCount: 3,
      duration: "auto",
    }, { rootDir });

    assert.equal(job.status, "pending");
    assert.equal(job.episodeCount, 3);
    assert.equal(job.completedCount, 0);
    assert.equal(job.projectId, null);

    await assert.rejects(
      () => createEpisodeBatchJob({ script: "abcdef", episodeCount: 31 }, { rootDir }),
      /Episode count must be between 1 and 30/,
    );

    const claimed = await claimNextEpisodeBatchJob({ rootDir, order: "oldest" });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.currentEpisodeNumber, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tracks saved versions and completes a batch job", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createEpisodeBatchJob({ script: "连续生成两集。", episodeCount: 2 }, { rootDir });
    await claimNextEpisodeBatchJob({ rootDir, order: "oldest" });

    const first = await appendEpisodeBatchVersion(job.id, {
      projectId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      versionNumber: 1,
      title: "第一集",
    }, { rootDir });
    assert.equal(first.completedCount, 1);
    assert.equal(first.projectId, "11111111-1111-4111-8111-111111111111");
    assert.equal(first.currentEpisodeNumber, 2);

    const second = await appendEpisodeBatchVersion(job.id, {
      projectId: "11111111-1111-4111-8111-111111111111",
      versionId: "33333333-3333-4333-8333-333333333333",
      versionNumber: 2,
      title: "第二集",
    }, { rootDir });
    assert.equal(second.completedCount, 2);

    const completed = await completeEpisodeBatchJob(job.id, { rootDir });
    assert.equal(completed.status, "completed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("partial failure, retry, and cancel preserve completed episodes", async () => {
  const rootDir = makeTempRoot();
  try {
    const job = await createEpisodeBatchJob({ script: "连续生成三集。", episodeCount: 3 }, { rootDir });
    await claimNextEpisodeBatchJob({ rootDir, order: "oldest" });
    await appendEpisodeBatchVersion(job.id, {
      projectId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      versionNumber: 1,
      title: "第一集",
    }, { rootDir });

    const failed = await failEpisodeBatchJob(job.id, "episode 2 failed", { rootDir });
    assert.equal(failed.status, "partial_failed");
    assert.equal(failed.completedCount, 1);
    assert.equal(failed.failedAtIndex, 2);

    const retried = await retryEpisodeBatchJob(job.id, { rootDir });
    assert.equal(retried.status, "pending");
    assert.equal(retried.completedCount, 1);
    assert.equal(retried.currentEpisodeNumber, 2);

    const cancelled = await cancelEpisodeBatchJob(job.id, { rootDir });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.completedCount, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
node --test test/episode-batch-queue.test.mjs
```

Expected: FAIL because `lib/episode-batch-queue.ts` does not exist.

- [ ] **Step 3: Implement queue**

Create `lib/episode-batch-queue.ts` with:

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type EpisodeBatchJobStatus = "pending" | "running" | "completed" | "partial_failed" | "cancelled";

export type CreateEpisodeBatchJobInput = {
  projectId?: string;
  script: string;
  episodeCount: number;
  duration?: string;
};

export type EpisodeBatchVersion = {
  projectId: string;
  versionId: string;
  versionNumber: number;
  title: string;
};

export type EpisodeBatchJob = {
  id: string;
  status: EpisodeBatchJobStatus;
  script: string;
  duration: string;
  episodeCount: number;
  projectId: string | null;
  completedCount: number;
  currentEpisodeNumber: number | null;
  failedAtIndex: number | null;
  versions: EpisodeBatchVersion[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

type QueueOptions = { rootDir?: string };
type ClaimOptions = QueueOptions & { order?: "oldest" | "newest" };

const TASK_ROOT = ".tmp-episode-batch";
const JOB_DIR = "jobs";

export class EpisodeBatchQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeBatchQueueError";
  }
}

export async function createEpisodeBatchJob(input: CreateEpisodeBatchJobInput, options: QueueOptions = {}) {
  validateCreateInput(input);
  const rootDir = resolveRootDir(options);
  const now = new Date().toISOString();
  const job: EpisodeBatchJob = {
    id: createId("episode-batch-job"),
    status: "pending",
    script: input.script.trim(),
    duration: input.duration?.trim() || "auto",
    episodeCount: input.episodeCount,
    projectId: input.projectId || null,
    completedCount: 0,
    currentEpisodeNumber: null,
    failedAtIndex: null,
    versions: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeJob(rootDir, job);
  return job;
}

export async function getEpisodeBatchJob(jobId: string, options: QueueOptions = {}) {
  return readJob(resolveRootDir(options), jobId);
}

export async function claimNextEpisodeBatchJob(options: ClaimOptions = {}) {
  const rootDir = resolveRootDir(options);
  const jobs = await listJobs(rootDir);
  const direction = options.order === "oldest" ? 1 : -1;
  const next = jobs
    .filter((job) => job.status === "pending")
    .sort((left, right) => direction * (Date.parse(left.createdAt) - Date.parse(right.createdAt)))[0];
  if (!next) return null;
  const updated = {
    ...next,
    status: "running" as const,
    currentEpisodeNumber: next.completedCount + 1,
    failedAtIndex: null,
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJob(rootDir, updated);
  return updated;
}

export async function appendEpisodeBatchVersion(jobId: string, version: EpisodeBatchVersion, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const versions = [...job.versions, version];
  const completedCount = versions.length;
  const updated: EpisodeBatchJob = {
    ...job,
    projectId: job.projectId || version.projectId,
    versions,
    completedCount,
    currentEpisodeNumber: completedCount < job.episodeCount ? completedCount + 1 : job.episodeCount,
    updatedAt: new Date().toISOString(),
  };
  await writeJob(rootDir, updated);
  return updated;
}

export async function completeEpisodeBatchJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const now = new Date().toISOString();
  const updated = { ...job, status: "completed" as const, error: null, completedAt: now, updatedAt: now };
  await writeJob(rootDir, updated);
  return updated;
}

export async function failEpisodeBatchJob(jobId: string, message: string | undefined, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated: EpisodeBatchJob = {
    ...job,
    status: "partial_failed",
    failedAtIndex: job.completedCount + 1,
    currentEpisodeNumber: job.completedCount + 1,
    error: message || "Episode batch generation failed",
    updatedAt: new Date().toISOString(),
  };
  await writeJob(rootDir, updated);
  return updated;
}

export async function retryEpisodeBatchJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = {
    ...job,
    status: "pending" as const,
    failedAtIndex: null,
    currentEpisodeNumber: job.completedCount + 1,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  await writeJob(rootDir, updated);
  return updated;
}

export async function cancelEpisodeBatchJob(jobId: string, options: QueueOptions = {}) {
  const rootDir = resolveRootDir(options);
  const job = await readJob(rootDir, jobId);
  const updated = { ...job, status: "cancelled" as const, updatedAt: new Date().toISOString() };
  await writeJob(rootDir, updated);
  return updated;
}

function validateCreateInput(input: CreateEpisodeBatchJobInput) {
  if (String(input.script || "").trim().length < 5) throw new EpisodeBatchQueueError("Script must contain at least 5 characters");
  if (!Number.isInteger(input.episodeCount) || input.episodeCount < 1 || input.episodeCount > 30) {
    throw new EpisodeBatchQueueError("Episode count must be between 1 and 30");
  }
}

async function listJobs(rootDir: string) {
  await ensureQueueDirs(rootDir);
  const entries = await readdir(jobDir(rootDir), { withFileTypes: true });
  const jobs = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => readJob(rootDir, entry.name.replace(/\.json$/, ""))));
  return jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

async function readJob(rootDir: string, jobId: string): Promise<EpisodeBatchJob> {
  try {
    return JSON.parse(await readFile(jobPath(rootDir, jobId), "utf8")) as EpisodeBatchJob;
  } catch (error) {
    throw new EpisodeBatchQueueError((error as NodeJS.ErrnoException).code === "ENOENT" ? "Episode batch job not found" : "Episode batch job could not be read");
  }
}

async function writeJob(rootDir: string, job: EpisodeBatchJob) {
  await ensureQueueDirs(rootDir);
  await writeFile(jobPath(rootDir, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function ensureQueueDirs(rootDir: string) {
  await mkdir(jobDir(rootDir), { recursive: true });
}

function resolveRootDir(options: QueueOptions) {
  return options.rootDir || process.cwd();
}

function jobDir(rootDir: string) {
  return path.join(rootDir, TASK_ROOT, JOB_DIR);
}

function jobPath(rootDir: string, jobId: string) {
  return path.join(jobDir(rootDir), `${fileSegment(jobId)}.json`);
}

function createId(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function fileSegment(value: string) {
  return path.basename(String(value || "").replace(/[\\/:*?"<>|]+/g, "-"));
}
```

- [ ] **Step 4: Run queue tests**

Run:

```powershell
node --test test/episode-batch-queue.test.mjs
```

Expected: PASS.

## Task 2: Batch API Routes

**Files:**
- Create API route files under `app/api/episode-batch/jobs`
- Test: `test/episode-batch-api.test.mjs`

- [ ] **Step 1: Write failing API route tests**

Create `test/episode-batch-api.test.mjs` with source checks:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("episode batch job API exposes create, poll, claim, fail, complete, cancel, and retry routes", () => {
  const routes = [
    "app/api/episode-batch/jobs/route.ts",
    "app/api/episode-batch/jobs/[jobId]/route.ts",
    "app/api/episode-batch/jobs/claim/route.ts",
    "app/api/episode-batch/jobs/[jobId]/complete/route.ts",
    "app/api/episode-batch/jobs/[jobId]/fail/route.ts",
    "app/api/episode-batch/jobs/[jobId]/cancel/route.ts",
    "app/api/episode-batch/jobs/[jobId]/retry/route.ts",
  ];
  for (const route of routes) assert.equal(existsSync(route), true, `${route} should exist`);

  const createRoute = readFileSync(routes[0], "utf8");
  assert.match(createRoute, /episodeCount: z\.number\(\)\.int\(\)\.min\(1\)\.max\(30\)/);
  assert.match(createRoute, /createEpisodeBatchJob/);

  const claimRoute = readFileSync(routes[2], "utf8");
  assert.match(claimRoute, /EPISODE_BATCH_WORKER_TOKEN/);
  assert.match(claimRoute, /claimNextEpisodeBatchJob/);

  const cancelRoute = readFileSync(routes[5], "utf8");
  assert.match(cancelRoute, /cancelEpisodeBatchJob/);

  const retryRoute = readFileSync(routes[6], "utf8");
  assert.match(retryRoute, /retryEpisodeBatchJob/);
});
```

- [ ] **Step 2: Run failing API tests**

Run:

```powershell
node --test test/episode-batch-api.test.mjs
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement API routes**

Use the same response shape as existing local job APIs: `{ ok: true, job }` or `{ ok: false, error }`.

Create:

```ts
// app/api/episode-batch/jobs/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { createEpisodeBatchJob } from "@/lib/episode-batch-queue";

export const runtime = "nodejs";

const RequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  script: z.string().min(5).max(50_000),
  episodeCount: z.number().int().min(1).max(30),
  duration: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await request.json());
    const job = await createEpisodeBatchJob(body);
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || "Episode batch job creation failed" }, { status: 400 });
  }
}
```

Use `params: Promise<{ jobId: string }>` in dynamic routes, matching current Next 15 patterns if present in the repo.

- [ ] **Step 4: Run API tests**

Run:

```powershell
node --test test/episode-batch-api.test.mjs test/episode-batch-queue.test.mjs
```

Expected: PASS.

## Task 3: Worker Skeleton And Package Script

**Files:**
- Create: `scripts/episode-batch-worker.mjs`
- Modify: `package.json`
- Test: `test/episode-batch-worker.test.mjs`

- [ ] **Step 1: Write failing worker tests**

Create `test/episode-batch-worker.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("episode batch worker polls batch jobs and processes episodes sequentially", () => {
  const source = readFileSync("scripts/episode-batch-worker.mjs", "utf8");
  assert.match(source, /Local Director episode batch worker started/);
  assert.match(source, /\/api\/episode-batch\/jobs\/claim/);
  assert.match(source, /for \(let index = task\.completedCount; index < task\.episodeCount; index \+= 1\)/);
  assert.match(source, /createVideoPromptJob/);
  assert.match(source, /pollVideoPromptJob/);
  assert.match(source, /saveProjectVersion/);
  assert.match(source, /appendBatchVersion/);
});

test("package exposes episode batch worker command", () => {
  const pkg = readFileSync("package.json", "utf8");
  assert.match(pkg, /"episode-batch:worker": "node scripts\/episode-batch-worker\.mjs"/);
});
```

- [ ] **Step 2: Run failing worker tests**

Run:

```powershell
node --test test/episode-batch-worker.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement worker**

Create a minimal worker that:

- claims `/api/episode-batch/jobs/claim`
- loops from `task.completedCount` to `task.episodeCount`
- creates `/api/video-prompt/jobs`
- polls `/api/video-prompt/jobs/:jobId`
- saves `/api/projects`
- appends `/api/episode-batch/jobs/:jobId/complete` or a dedicated append endpoint if added during Task 2
- reports failure through `/api/episode-batch/jobs/:jobId/fail`

The initial worker can call local APIs over HTTP and does not need direct imports from Next code.

- [ ] **Step 4: Add package script**

In `package.json` add:

```json
"episode-batch:worker": "node scripts/episode-batch-worker.mjs"
```

- [ ] **Step 5: Run worker tests**

Run:

```powershell
node --test test/episode-batch-worker.test.mjs
```

Expected: PASS.

## Task 4: Dashboard Episode Count UI

**Files:**
- Modify: `components/DashboardClient.tsx`
- Test: `test/episode-batch-dashboard.test.mjs`

- [ ] **Step 1: Write failing dashboard tests**

Create `test/episode-batch-dashboard.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard exposes episode count control and uses batch jobs for multiple episodes", () => {
  const source = readFileSync("components/DashboardClient.tsx", "utf8");
  assert.match(source, /const \[episodeCount, setEpisodeCount\] = useState\(1\)/);
  assert.match(source, /aria-label="生成集数"/);
  assert.match(source, /Math\.min\(30, Math\.max\(1, nextCount\)\)/);
  assert.match(source, /episodeCount > 1/);
  assert.match(source, /createEpisodeBatchJob/);
  assert.match(source, /pollEpisodeBatchJob/);
  assert.match(source, /requestAnalysis\(script, selectedDurationValue\(\)\)/);
});
```

- [ ] **Step 2: Run failing dashboard tests**

Run:

```powershell
node --test test/episode-batch-dashboard.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement UI state and control**

Add state near duration state:

```ts
const [episodeCount, setEpisodeCount] = useState(1);
const [episodeCountPickerOpen, setEpisodeCountPickerOpen] = useState(false);
```

Add helper:

```ts
function updateEpisodeCount(nextCount: number) {
  setEpisodeCount(Math.min(30, Math.max(1, nextCount)));
}
```

Add compact toolbar control beside duration:

```tsx
<button
  type="button"
  className="prompt-duration-pill"
  aria-label="生成集数"
  aria-expanded={episodeCountPickerOpen}
  onClick={() => setEpisodeCountPickerOpen((open) => !open)}
>
  <Film className="h-3.5 w-3.5" />
  {episodeCount}集
</button>
```

- [ ] **Step 4: Add batch job client functions**

Add:

```ts
async function createEpisodeBatchJob(inputScript: string, inputDuration: string) {
  const res = await fetch("/api/episode-batch/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: inputScript,
      duration: inputDuration,
      episodeCount,
      projectId: resumeProjectId || undefined,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || "批量剧集任务创建失败");
  return data.job;
}
```

Add polling that updates `generationProgress` with `completedCount / episodeCount`.

- [ ] **Step 5: Branch analyze flow**

In `analyze()`:

```ts
if (!uploadedFileName && episodeCount > 1) {
  const job = await createEpisodeBatchJob(script, selectedDurationValue());
  const completedJob = await pollEpisodeBatchJob(job.id);
  setGenerationProgress(`已生成 ${completedJob.completedCount} / ${completedJob.episodeCount} 集，已保存到项目。`);
  if (completedJob.projectId) setResumeProjectId(completedJob.projectId);
  return;
}
```

Keep existing single-episode path unchanged.

- [ ] **Step 6: Run dashboard tests**

Run:

```powershell
node --test test/episode-batch-dashboard.test.mjs test/duration-control.test.mjs test/prompt-workflow.test.mjs
```

Expected: PASS.

## Task 5: End-To-End Integration Checks

**Files:**
- Modify tests only if source-level assertions need new function names.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
node --test test/episode-batch-queue.test.mjs test/episode-batch-api.test.mjs test/episode-batch-worker.test.mjs test/episode-batch-dashboard.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run type checks**

Run:

```powershell
npm run typecheck
npm run api:typecheck
```

Expected: both PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

Commit all implementation files:

```powershell
git add app/api/episode-batch lib/episode-batch-queue.ts scripts/episode-batch-worker.mjs components/DashboardClient.tsx package.json test/episode-batch-*.test.mjs
git commit -m "feat: add batch episode generation"
```

## Self-Review

- Spec coverage: UI count control, API, file queue, worker, sequential generation, failure preservation, retry/cancel, and tests are covered.
- Placeholder scan: no unfinished marker placeholders are present.
- Type consistency: `EpisodeBatchJob`, `EpisodeBatchVersion`, and status names are consistent across queue, API, worker, and dashboard tasks.
