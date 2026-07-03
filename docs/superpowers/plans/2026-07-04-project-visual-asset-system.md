# Project Visual Asset System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local Codex image generation for project-level character, scene, prop, and style assets.

**Architecture:** Reuse the existing `ProjectVisualEntity` and `VisualAsset` models. Add a small JSON queue, Next route handlers, a Codex worker script, and Projects page controls that generate and save asset images.

**Tech Stack:** Next.js route handlers, TypeScript, Node worker scripts, local JSON queue files, existing Nest project visual asset persistence.

---

### Task 1: Queue Contract And Tests

**Files:**
- Create: `test/visual-asset-codex-queue.test.mjs`
- Create: `lib/visual-asset-codex-queue.ts`

- [ ] **Step 1: Write failing queue tests**

Create tests that import:

```js
import {
  claimNextVisualAssetCodexTask,
  completeVisualAssetCodexTask,
  createVisualAssetCodexJob,
  getVisualAssetCodexJob,
} from "../lib/visual-asset-codex-queue.ts";
```

The tests should assert that a `CHARACTER` entity creates one `CHARACTER_TURNAROUND` task, writes output under `public/project-assets/visual-assets`, can be claimed, and can be completed after a small valid PNG is written.

- [ ] **Step 2: Run red test**

Run:

```powershell
node --test test/visual-asset-codex-queue.test.mjs
```

Expected: fails because the queue module does not exist.

- [ ] **Step 3: Implement queue**

Create `lib/visual-asset-codex-queue.ts` with:

- `createVisualAssetCodexJob`
- `getVisualAssetCodexJob`
- `claimNextVisualAssetCodexTask`
- `completeVisualAssetCodexTask`
- `failVisualAssetCodexTask`
- `failVisualAssetCodexJob`

Use `.tmp-visual-asset-codex/jobs` for job JSON and `public/project-assets/visual-assets/<projectId>/<entityId>` for PNG output.

- [ ] **Step 4: Run queue test green**

Run:

```powershell
node --test test/visual-asset-codex-queue.test.mjs
```

Expected: pass.

### Task 2: API Routes And Tests

**Files:**
- Create: `test/visual-asset-codex-api.test.mjs`
- Create: `app/api/visual-asset-image/jobs/route.ts`
- Create: `app/api/visual-asset-image/jobs/[jobId]/route.ts`
- Create: `app/api/visual-asset-image/jobs/claim/route.ts`
- Create: `app/api/visual-asset-image/jobs/[jobId]/complete/route.ts`
- Create: `app/api/visual-asset-image/jobs/[jobId]/fail/route.ts`

- [ ] **Step 1: Write failing route existence tests**

Assert each route exists and imports the matching visual asset queue function.

- [ ] **Step 2: Run red test**

Run:

```powershell
node --test test/visual-asset-codex-api.test.mjs
```

Expected: fails because route files do not exist.

- [ ] **Step 3: Implement route handlers**

Use Zod validation at the request boundary. Return `{ ok: true, job }` for create/get/complete/fail and `{ ok: true, task }` for claim.

- [ ] **Step 4: Run route test green**

Run:

```powershell
node --test test/visual-asset-codex-api.test.mjs
```

Expected: pass.

### Task 3: Worker Script And Package Script

**Files:**
- Create: `scripts/visual-asset-codex-worker.mjs`
- Modify: `package.json`
- Test: `test/visual-asset-codex-api.test.mjs`

- [ ] **Step 1: Extend tests**

Assert `package.json` contains `visual-asset:codex-worker` and the worker posts to `/api/visual-asset-image/jobs/claim`.

- [ ] **Step 2: Run red test**

Run:

```powershell
node --test test/visual-asset-codex-api.test.mjs
```

Expected: fails until script and package entry exist.

- [ ] **Step 3: Implement worker**

Mirror the storyboard worker pattern, but default `VISUAL_ASSET_CODEX_CONCURRENCY` to 2. Use `$imagegen`, write logs under `.tmp-visual-asset-codex/codex-logs`, validate PNG output, and report completion/failure to the visual asset job routes.

- [ ] **Step 4: Run route test green**

Run:

```powershell
node --test test/visual-asset-codex-api.test.mjs
```

Expected: pass.

### Task 4: Projects Page Controls

**Files:**
- Modify: `components/ProjectsClient.tsx`
- Test: `test/project-visual-asset-generation.test.mjs`

- [ ] **Step 1: Write failing UI source test**

Assert the Projects page defines visual asset job types, calls `/api/visual-asset-image/jobs`, polls the job, and saves completed assets through `/api/projects/visual-assets`.

- [ ] **Step 2: Run red test**

Run:

```powershell
node --test test/project-visual-asset-generation.test.mjs
```

Expected: fails until UI controls exist.

- [ ] **Step 3: Implement UI**

Add per-entity generation state, `createVisualAssetCodexJob`, `pollVisualAssetCodexJob`, `saveGeneratedVisualAsset`, and card buttons for generate/regenerate.

- [ ] **Step 4: Run UI test green**

Run:

```powershell
node --test test/project-visual-asset-generation.test.mjs
```

Expected: pass.

### Task 5: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run focused tests**

```powershell
node --test test/visual-asset-codex-queue.test.mjs test/visual-asset-codex-api.test.mjs test/project-visual-asset-generation.test.mjs
```

- [ ] **Step 2: Run type checks**

```powershell
npm run typecheck
npm run api:typecheck
```

- [ ] **Step 3: Run full tests**

```powershell
npm test
```

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat: add project visual asset generation"
```
