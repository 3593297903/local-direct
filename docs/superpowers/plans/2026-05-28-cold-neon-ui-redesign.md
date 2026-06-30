# Cold Neon UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing Next.js AI Video Director SaaS into a minimal cold-neon creator console.

**Architecture:** Keep all routes, APIs, and data contracts intact. Change only presentation components and small TypeScript typing issues needed for verification.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, Supabase SSR.

---

### Task 1: Global Theme Foundation

**Files:**
- Modify: `D:\ai-video-director-saas\app\globals.css`
- Modify: `D:\ai-video-director-saas\tailwind.config.ts`

- [ ] Replace the light global background with a cold dark app background, selection colors, scrollbar styling, and reusable utility classes: `.glass-panel`, `.neon-border`, `.control-input`, `.primary-neon`, `.muted-button`, `.section-shell`.
- [ ] Extend Tailwind shadow tokens if needed, preserving existing `shadow-soft` references.
- [ ] Run `npm.cmd run typecheck`; if failures are unrelated implicit Supabase cookie `any` errors, continue to Task 6.

### Task 2: Shell, Landing, And Login

**Files:**
- Modify: `D:\ai-video-director-saas\app\page.tsx`
- Modify: `D:\ai-video-director-saas\app\login\page.tsx`
- Modify: `D:\ai-video-director-saas\app\layout.tsx`

- [ ] Redesign homepage as a dark AI director console hero with product-first signal, workflow panels, and restrained feature sections.
- [ ] Redesign login as a compact dark auth panel using the same brand surfaces.
- [ ] Keep metadata and route behavior unchanged.

### Task 3: Dashboard Console

**Files:**
- Modify: `D:\ai-video-director-saas\components\DashboardClient.tsx`

- [ ] Replace rounded light SaaS hero with dark workspace layout.
- [ ] Style textarea, parameter controls, analyze action, errors, result summaries, table, recommendation chips, and editing notes using the cold-neon utilities.
- [ ] Preserve existing state, API payload, result rendering, and copy actions.

### Task 4: Navigation And Library Surfaces

**Files:**
- Modify: `D:\ai-video-director-saas\components\Sidebar.tsx`
- Modify: `D:\ai-video-director-saas\components\LibraryClient.tsx`
- Modify: `D:\ai-video-director-saas\components\LibraryCard.tsx`
- Modify: `D:\ai-video-director-saas\components\Drawer.tsx`
- Modify: `D:\ai-video-director-saas\components\CopyButton.tsx`
- Modify: `D:\ai-video-director-saas\components\PreviewAnimation.tsx`

- [ ] Convert nav, cards, drawer, copy buttons, search, category chips, and preview blocks to dark surfaces.
- [ ] Use cyan active/hover states and keep text contrast readable.
- [ ] Preserve filtering, drawer selection, and copy behavior.

### Task 5: Verification In Browser

**Files:**
- No code changes unless visual issues are found.

- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build` if typecheck passes.
- [ ] Start `npm.cmd run dev` and inspect `/`, `/dashboard`, `/library`, and `/login`.
- [ ] Fix visible overlap, contrast, and layout issues.

### Task 6: Typecheck Fix If Needed

**Files:**
- Modify: `D:\ai-video-director-saas\lib\supabase-server.ts`
- Modify: `D:\ai-video-director-saas\middleware.ts`

- [ ] If verification is blocked by implicit `any` in Supabase cookie callbacks, add narrow local cookie parameter types to those callbacks.
- [ ] Re-run `npm.cmd run typecheck`.

## Self-Review

- Spec coverage: global theme, homepage, dashboard, library, sidebar, drawer, login, and verification are covered.
- Scope: visual-only with one optional TypeScript verification fix.
- Placeholders: no open implementation placeholders remain; each task has exact files and expected checks.
