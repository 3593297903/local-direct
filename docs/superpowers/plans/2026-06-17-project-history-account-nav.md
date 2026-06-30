# Project History Account Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saved projects feel reliable and user-owned by fixing detail loading feedback, showing account state across main pages, and polishing the project history page.

**Architecture:** Keep Nest as the source of project data and auth state. Add a reusable Next client account nav that calls `/api/auth/me`, then mount it in the public workspace shells without interfering with library admin controls. Keep project history UI as one client container for now, but improve its states and layout.

**Tech Stack:** Next.js App Router, React client components, NestJS project/auth APIs, Prisma-backed data, Tailwind CSS, Node test runner.

---

### Task 1: Tests

**Files:**
- Modify: `test/projects-history-page.test.mjs`
- Create: `test/user-account-nav.test.mjs`

- [ ] Add tests that assert the project page imports and renders `UserAccountNav`, includes account/empty/error copy, and keeps resume/download actions.
- [ ] Add tests that assert dashboard, library, and projects pages mount `UserAccountNav`.
- [ ] Add tests that assert `UserAccountNav` calls `/api/auth/me`, shows login/register when signed out, and shows email/phone plus logout when signed in.
- [ ] Run `node --test test/projects-history-page.test.mjs test/user-account-nav.test.mjs` and confirm the new expectations fail before implementation.

### Task 2: Account Nav

**Files:**
- Create: `components/UserAccountNav.tsx`
- Modify: `app/page.tsx`
- Modify: `app/dashboard/page.tsx`
- Modify: `app/library/page.tsx`
- Modify: `app/projects/page.tsx`

- [ ] Implement a compact top-right account component with signed-out and signed-in states.
- [ ] Mount it in the four user-facing pages with fixed positioning that avoids the library admin toolbar.
- [ ] Keep admin login hidden from public library pages; admin remains reachable through admin URL.

### Task 3: Project History Polish

**Files:**
- Modify: `components/ProjectsClient.tsx`
- Modify: `lib/nest-projects-proxy.ts`

- [ ] Improve project detail error copy so upstream 404 explains API restart or missing project instead of raw `Not Found`.
- [ ] Add clearer empty, loading, and selected-project states.
- [ ] Make the detail table horizontally scroll on smaller screens.
- [ ] Keep “继续编辑”, “复制提示词”, and “下载 DOCX”.

### Task 4: Verification

**Files:**
- No new files.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run api:typecheck`.
- [ ] Restart local API/frontend if needed and verify `/projects` returns 200.
