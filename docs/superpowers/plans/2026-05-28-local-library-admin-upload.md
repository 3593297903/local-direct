# Local Library Admin Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local admin page for uploading media previews and editing knowledge-library metadata.

**Architecture:** Store editable item metadata in `data/knowledge-items.json` and media files in `public/previews`. Add a filesystem-backed library store used by the public library route and admin API. Library rendering prefers uploaded `previewUrl` media and falls back to existing animated placeholders.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, Node filesystem APIs, built-in Node test runner.

---

### Task 1: Storage Contract And Tests

**Files:**
- Modify: `D:\ai-video-director-saas\types\index.ts`
- Create: `D:\ai-video-director-saas\lib\library-store.ts`
- Create: `D:\ai-video-director-saas\test\library-store.test.mjs`

- [ ] Add `previewUrl?: string` and `previewMimeType?: string` to `KnowledgeItem`.
- [ ] Write Node tests proving local items can override defaults and uploaded file names are sanitized.
- [ ] Implement `readLocalKnowledgeItems`, `writeLocalKnowledgeItems`, `getMergedKnowledgeItems`, `sanitizeUploadName`, and `savePreviewFile`.

### Task 2: API Routes

**Files:**
- Create: `D:\ai-video-director-saas\app\api\admin\library\route.ts`
- Modify: `D:\ai-video-director-saas\app\api\library\route.ts`

- [ ] Add `GET /api/admin/library` for merged items.
- [ ] Add `POST /api/admin/library` accepting `multipart/form-data` metadata plus optional media file.
- [ ] Update public library API to read merged items from the store.

### Task 3: Preview Rendering

**Files:**
- Modify: `D:\ai-video-director-saas\components\PreviewAnimation.tsx`
- Modify: `D:\ai-video-director-saas\components\LibraryCard.tsx`
- Modify: `D:\ai-video-director-saas\components\Drawer.tsx`

- [ ] Update preview component props to accept the full item.
- [ ] Render uploaded images/GIFs with `<img>`.
- [ ] Render uploaded MP4/WebM with `<video muted autoPlay loop playsInline>`.
- [ ] Fall back to existing animated preview if no `previewUrl`.

### Task 4: Admin UI

**Files:**
- Create: `D:\ai-video-director-saas\app\admin\library\page.tsx`
- Create: `D:\ai-video-director-saas\components\AdminLibraryClient.tsx`
- Modify: `D:\ai-video-director-saas\components\Sidebar.tsx`

- [ ] Add a dark admin form for selecting existing items or creating a new item.
- [ ] Include fields for type, category, name, description, tags, stability, use case, avoid text, and prompt.
- [ ] Include a file input for image/GIF/video upload.
- [ ] Save via the admin API and refresh local state.
- [ ] Add sidebar link to the admin page.

### Task 5: Verification

**Files:**
- No production changes unless verification reveals issues.

- [ ] Run `npm.cmd test`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Start dev server and verify `/admin/library`, `/library?type=transition`, and media preview rendering.

## Self-Review

- Spec coverage: metadata editing, media upload, frontend preview, API, and verification are covered.
- Placeholder scan: no incomplete task placeholders remain.
- Scope: local MVP only; Supabase-backed cloud upload is explicitly out of scope for this iteration.
