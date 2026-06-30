# Cold Neon UI Redesign

## Goal

Restyle `ai-video-director-saas` into a minimal, cinematic, cold-neon AI video director console. Keep the existing Next.js/Supabase/AI-provider architecture and current product routes, but replace the rounded light SaaS visual language with a darker, sharper, more professional creator tool interface.

## Visual Direction

- Base palette: near-black, deep blue-black, slate, and soft white.
- Accent palette: cyan and electric blue, used sparingly for active states, primary actions, borders, and status marks.
- Surface style: dark panels, subtle transparency, fine borders, restrained glow, compact spacing.
- Shape language: 8-16px radii, not oversized pill/card-heavy layouts.
- Typography: clear hierarchy, no viewport-scaled type, no negative letter spacing.

## Scope

- `app/globals.css`: global background, reusable dark surface utilities, button/input/table polish.
- `app/page.tsx`: homepage becomes a product-first AI director console hero with workflow signals and feature panels.
- `components/DashboardClient.tsx`: dark script analyzer workspace, compact parameter controls, neon primary action, dark result tables/cards.
- `components/Sidebar.tsx`: darker app rail with compact navigation and active cyan state.
- `components/LibraryClient.tsx`, `LibraryCard.tsx`, `Drawer.tsx`, `CopyButton.tsx`, `PreviewAnimation.tsx`: library and detail surfaces align with the cold-neon console style.
- `app/login/page.tsx`: simple login view in the same brand system.

## Behavior

No backend behavior changes. Existing API calls, mock analysis, library filtering, copy actions, auth flow, and project save foundations stay intact.

## Verification

- Run TypeScript check after edits. Existing Supabase cookie typings may need a small fix if typecheck is blocked by implicit `any`.
- Start the Next dev server with `npm.cmd run dev`.
- Inspect homepage, dashboard, library, and login in browser at desktop width.
- Confirm pages render without obvious overlap, unreadable contrast, or broken interactions.
