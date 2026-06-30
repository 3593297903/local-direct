# Local Director Agent Context

## Project Identity

This repository is `Local Director`, a portable copy of the original `AI Video Director SaaS` project.

Workspace path:

```text
E:\localdirector
```

Primary product goal:

- Keep the user-facing app focused on two sections only:
  - Dashboard / 工作台
  - My Projects / 我的项目
- Preserve the full generation, project saving, authentication, NestJS API, Prisma, PostgreSQL, Redis, and narrative memory pipeline.
- Keep the app movable to another Windows computer with Docker Desktop and Node.js.

This is not a lightweight rewrite. It is a full local working copy with hidden/non-primary modules kept for compatibility.

## Important Scope Boundary

Do not treat `E:\video-director-main` as the active project when working here.

The active project for this workspace is:

```text
E:\localdirector
```

Only edit files under `E:\localdirector` unless the user explicitly asks to modify the original project.

## User-Facing Navigation

The normal user navigation should expose only:

- `/dashboard` - 工作台
- `/projects` - 我的项目

The following modules may still exist in the codebase for compatibility, internal data, or admin use, but should not be reintroduced into the main user navigation without explicit user request:

- `/library`
- shot / 景别
- camera movement / 运镜
- transition / 转场
- style / 风格

## Tech Stack

- Frontend: Next.js 15, React 19, TypeScript, Tailwind CSS
- Backend: NestJS 11 under `apps/api`
- Database: PostgreSQL via Prisma
- Cache / queue: Redis / BullMQ
- AI orchestration: `lib/ai.ts`, `lib/agent/video-director-graph.ts`
- Project persistence: `Project`, `ProjectVersion`, `StoryboardShot`
- Narrative memory: `MemoryItem`, `CharacterProfile`, `StoryLoop`, story bible, state vectors, open loops

## Local Ports And Isolation

This project is intentionally isolated from the original `video-director-main` runtime.

Use these local ports:

```text
Next.js frontend: http://localhost:3100
NestJS API:       http://localhost:4100/api
PostgreSQL:       localhost:55432
Redis:            localhost:56379
```

Docker resources:

```text
PostgreSQL container: localdirector-postgres
Redis container:      localdirector-redis
PostgreSQL volume:    localdirector_postgres
Redis volume:         localdirector_redis
```

Avoid changing these back to `3000`, `4000`, `5432`, or `6379` unless the user explicitly wants to merge runtime environments.

## Setup Commands

First-time local setup:

```powershell
cd E:\localdirector
npm run local:start
```

Start backend:

```powershell
cd E:\localdirector
npm run api:dev
```

Start frontend:

```powershell
cd E:\localdirector
npm run dev:local
```

Useful checks:

```powershell
npm run typecheck
npm run api:typecheck
npm run build
npm test
```

## Key Files

- `components/Sidebar.tsx` - user navigation; should remain Dashboard + My Projects only.
- `components/DashboardClient.tsx` - main prompt input and generation workflow UI.
- `components/ProjectsClient.tsx` - project list, episodes, saved prompts, project management.
- `app/dashboard/page.tsx` - dashboard route.
- `app/projects/page.tsx` - projects route.
- `app/api/analyze/route.ts` - Next API entry for generation.
- `lib/ai.ts` - provider calls, retry rules, output validation, prompt generation helpers.
- `lib/agent/video-director-graph.ts` - director workflow and storyboard generation orchestration.
- `lib/nest-projects-proxy.ts` - Next-to-Nest proxy for projects.
- `apps/api/src/modules/projects/projects.service.ts` - Nest project persistence and memory logic.
- `apps/api/src/modules/auth` - user auth.
- `apps/api/src/modules/admin` - admin APIs.
- `prisma/schema.prisma` - database schema.
- `docker-compose.yml` - isolated local PostgreSQL and Redis.
- `README-localdirector.md` - portable setup guide.

## Narrative Memory Model

The project uses a structured narrative memory model. Do not replace it with chat-history stuffing.

The intended layers are:

1. User preferences
2. Project story bible
3. Episode summary and ending state
4. Memory retrieval through `MemoryItem`, `CharacterProfile`, and `StoryLoop`
5. Current user input and generation rules

`fullVideoPrompt` is user-facing archive text. Keep it preserved exactly when saving projects. Do not rewrite it merely for storage.

## Project And Episode Semantics

Treat:

- `Project` as a whole series / story project.
- `ProjectVersion` as an episode, displayed as 第 1 集, 第 2 集, etc.

Rules:

- "新建生成" from the project list or global projects page creates a new Project with episode 1.
- "新建一集" inside an existing project creates the next episode for that same Project and may use that project's memory.
- "继续编辑" on an episode updates that episode, not a new project.

Do not mix memory across projects unless the user explicitly asks for global/shared memory.

## Admin And Internal Modules

Admin pages and library management may remain available for maintenance:

- `/admin`
- `/admin/users`
- `/admin/library`

They are not part of the simplified user-facing navigation.

Admin login is based on `.env` / `.env.local` admin credentials.

## Editing Rules

- Prefer existing patterns and helpers over new architecture.
- Keep edits scoped to `E:\localdirector`.
- Do not delete hidden compatibility routes just because the user-facing nav hides them.
- Do not commit or expose `.env`, `.env.local`, local backups, logs, or database dumps.
- Do not modify the original `E:\video-director-main` unless asked.
- Use `apply_patch` for manual edits.
- Run relevant verification before claiming a fix is complete.

## Common Gotchas

- If admin user creation fails with `Can't reach database server at localhost:55432`, Docker Desktop or the local PostgreSQL container is not running.
- If Redis errors mention `localhost:56379`, start the local Redis container.
- If ports conflict, check whether another app is already using `3100`, `4100`, `55432`, or `56379`.
- If Prisma types are missing, run `npx prisma generate`.
- If database tables are missing, run `npx prisma migrate deploy` after Docker is running.
- The original project may use different ports and containers; do not point Local Director at those by accident.
