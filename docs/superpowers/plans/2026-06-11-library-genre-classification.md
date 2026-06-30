# Library Genre Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one selectable genre category to each library material and backfill existing transition, shot, and camera movement items.

**Architecture:** Store the genre as `KnowledgeItem.genre?: string` so existing `category` filters remain unchanged. Reuse one shared genre option list in both admin editors, API persistence, filtering, and tests.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Node test runner, JSON local data store.

---

### Task 1: Shared Genre Options And Search Behavior

**Files:**
- Create: `lib/genre-options.ts`
- Modify: `types/index.ts`
- Modify: `lib/library-store.ts`
- Test: `test/library-genre.test.mjs`

- [ ] Write a failing test that verifies the required genres exist and `filterKnowledgeItems` can find an item by `genre`.
- [ ] Add the shared `GENRE_OPTIONS` array and optional `genre` field.
- [ ] Include `genre` in library search text.
- [ ] Run the focused test.

### Task 2: Admin Editor Persistence

**Files:**
- Modify: `components/LibraryClient.tsx`
- Modify: `components/AdminLibraryClient.tsx`
- Modify: `app/api/admin/library/route.ts`

- [ ] Add a genre dropdown to both material edit forms.
- [ ] Submit `genre` in form data from both editors.
- [ ] Persist `genre` in the admin library POST route.
- [ ] Keep existing category behavior unchanged.

### Task 3: Backfill Existing Local Materials

**Files:**
- Modify: `data/knowledge-items.json`

- [ ] Classify only `transition`, `shot`, and `camera_movement` items.
- [ ] Use one genre from the approved list per item.
- [ ] Preserve all existing ids, order, preview URLs, posters, and category values.

### Task 4: Verification

**Files:**
- Test commands only.

- [ ] Run `npm.cmd test -- test/library-genre.test.mjs`.
- [ ] Run related library tests.
- [ ] Run `npm.cmd run typecheck`.
