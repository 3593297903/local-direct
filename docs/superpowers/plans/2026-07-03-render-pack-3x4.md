# Render Pack 3x4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-segment video prompt generation run as 3 concurrent render-pack jobs, with up to 4 segments per pack, while preserving existing single-segment quality repair gates.

**Architecture:** Keep the existing season planning and render-pack pipeline. Change only the bounded pack size/concurrency defaults and tests that assert those contracts, so quality validation and single-segment repair remain unchanged.

**Tech Stack:** Next.js React client, local Codex JSON queues, Node worker scripts, node:test.

---

### Task 1: Pin The 3x4 Contract In Tests

**Files:**
- Modify: `test/episode-batch-dashboard.test.mjs`
- Modify: `test/video-prompt-pack-codex-api.test.mjs`
- Modify: `test/video-prompt-pack-codex-queue.test.mjs`

- [ ] Update dashboard source assertions to expect `BATCH_RENDER_PACK_SIZE = 4` and `BATCH_RENDER_PACK_CONCURRENCY = 3`.
- [ ] Update render-pack queue test to create and complete 4 segment result files.
- [ ] Add a worker source assertion that the default `VIDEO_PROMPT_PACK_CODEX_CONCURRENCY` fallback is 3.
- [ ] Run the focused tests and confirm they fail before production changes.

### Task 2: Implement The 3x4 Runtime Defaults

**Files:**
- Modify: `components/DashboardClient.tsx`
- Modify: `scripts/video-prompt-pack-codex-worker.mjs`
- Verify: `lib/video-prompt-pack-codex-queue.ts`

- [ ] Change dashboard pack size to 4.
- [ ] Change dashboard concurrent pack jobs to 3.
- [ ] Change pack worker default concurrency to 3, still bounded by the existing max.
- [ ] Verify the queue already rejects more than 4 segments per pack.
- [ ] Run focused tests, then type checks.
