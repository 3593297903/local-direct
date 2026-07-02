# Season One-Shot Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace slow multi-episode serial generation with one Codex CLI season file-pack job for 1-30 episodes, then validate and save each episode in order.

**Architecture:** Add a separate season-pack queue, API, and worker beside the existing video-prompt queue. Dashboard multi-episode generation creates one season-pack job, polls until Codex writes per-episode JSON files, then saves the returned AnalysisResult objects sequentially to preserve project memory.

**Tech Stack:** Next.js App Router API routes, React Dashboard client, Node file queue, Codex CLI worker, Nest project save proxy.

---

### Task 1: API Body Limit

**Files:**
- Modify: `apps/api/src/main.ts`
- Test: `test/api-body-limit.test.mjs`

- [ ] Write a source test that asserts Nest disables the default parser and registers JSON/urlencoded parsers with `API_JSON_BODY_LIMIT`.
- [ ] Run `node --test test/api-body-limit.test.mjs` and confirm it fails.
- [ ] Update `apps/api/src/main.ts` to use `NestFactory.create(AppModule, { bodyParser: false })`, `json({ limit: bodyLimit })`, and `urlencoded({ extended: true, limit: bodyLimit })`.
- [ ] Run the test and `npm run api:typecheck`.
- [ ] Commit: `fix: raise api json body limit`.

### Task 2: Season Pack Queue

**Files:**
- Create: `lib/season-pack-codex-queue.ts`
- Test: `test/season-pack-codex-queue.test.mjs`

- [ ] Write tests for creating a job with `episodeCount` 1-30, rejecting 31, claiming pending jobs, completing from `episodes/episode-001.json`, and failing when expected episodes are missing.
- [ ] Run `node --test test/season-pack-codex-queue.test.mjs` and confirm failure.
- [ ] Implement queue directories under `.tmp-season-pack-codex/jobs`, `.tmp-season-pack-codex/packs`, and validation helpers.
- [ ] Run the queue test.
- [ ] Commit: `feat: add season pack codex queue`.

### Task 3: Season Pack API

**Files:**
- Create: `app/api/season-pack/jobs/route.ts`
- Create: `app/api/season-pack/jobs/[jobId]/route.ts`
- Create: `app/api/season-pack/jobs/claim/route.ts`
- Create: `app/api/season-pack/jobs/[jobId]/complete/route.ts`
- Create: `app/api/season-pack/jobs/[jobId]/fail/route.ts`
- Test: `test/season-pack-codex-api.test.mjs`

- [ ] Write source tests that assert the routes import and call the queue functions and use `SEASON_PACK_CODEX_WORKER_TOKEN`.
- [ ] Run the API test and confirm failure.
- [ ] Add routes following the existing video-prompt Codex API pattern.
- [ ] Run the API test.
- [ ] Commit: `feat: add season pack codex api`.

### Task 4: Season Pack Worker

**Files:**
- Create: `scripts/season-pack-codex-worker.mjs`
- Modify: `package.json`
- Test: `test/season-pack-codex-worker.test.mjs`

- [ ] Write source tests that assert the worker polls `/api/season-pack/jobs/claim`, runs `codex exec`, writes per-job last message logs, supports `SEASON_PACK_CODEX_MODEL` and `SEASON_PACK_CODEX_PROFILE`, and completes/fails via season-pack routes.
- [ ] Run the worker test and confirm failure.
- [ ] Implement the worker by adapting `scripts/video-prompt-codex-worker.mjs`.
- [ ] Add `season-pack:codex-worker` to `package.json`.
- [ ] Run the worker test.
- [ ] Commit: `feat: add season pack codex worker`.

### Task 5: Dashboard Integration

**Files:**
- Modify: `components/DashboardClient.tsx`
- Test: `test/episode-batch-dashboard.test.mjs`
- Test: `test/season-pack-dashboard.test.mjs`

- [ ] Update tests to assert multi-episode generation creates `/api/season-pack/jobs` instead of looping through `requestAnalysisWithContext`.
- [ ] Run the dashboard tests and confirm failure.
- [ ] Add `SeasonPackCodexJob` types, create/poll helpers, and replace `runBatchEpisodeGeneration` internals with one season-pack job plus sequential project saves.
- [ ] Save each episode with compact per-episode `originalScript`, not the entire source script.
- [ ] Run the dashboard tests.
- [ ] Commit: `feat: use season pack generation for multi episode prompts`.

### Task 6: Final Verification

**Files:**
- No new files unless verification reveals a bug.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run api:typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build` if typecheck and tests pass.
- [ ] Fix failures in the smallest possible follow-up commit.
- [ ] Push `main` to GitHub.
