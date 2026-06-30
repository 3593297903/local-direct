# Local Director Project Context

## What This Project Is

`Local Director` is a portable copy of the larger `AI Video Director SaaS` project. It exists so the user can continue developing a focused local version that only exposes:

- 工作台
- 我的项目

The original codebase had additional visible library sections for:

- 转场
- 景别
- 运镜
- 风格

In this local copy, those should not be shown in the main user navigation. The underlying code and data may remain because the generation pipeline can still depend on knowledge/library data.

## Why This Copy Exists

The user wants a project that can be moved to another computer and used directly with minimal setup. Therefore this copy keeps:

- frontend code
- NestJS backend
- Prisma schema
- Docker PostgreSQL and Redis
- AI prompt generation pipeline
- project history
- episode memory
- public assets

It intentionally removes or excludes:

- Git history
- build cache
- test screenshots
- backup SQL dumps
- old temporary preview backups
- local Claude/Codex cache files

## Runtime Isolation

This project must not collide with the original `E:\video-director-main`.

| Component | Local Director |
|---|---|
| Next.js | `http://localhost:3100` |
| NestJS API | `http://localhost:4100/api` |
| PostgreSQL | `localhost:55432` |
| Redis | `localhost:56379` |
| Postgres container | `localdirector-postgres` |
| Redis container | `localdirector-redis` |
| Postgres volume | `localdirector_postgres` |
| Redis volume | `localdirector_redis` |

## Development Flow

Start infrastructure:

```powershell
cd E:\localdirector
docker compose up -d postgres redis
npx prisma migrate deploy
npx prisma generate
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

Open:

```text
http://localhost:3100/dashboard
http://localhost:3100/projects
```

## Architecture Map

### Frontend

- `app/page.tsx` - landing page; should link to Dashboard and My Projects.
- `components/Sidebar.tsx` - simplified side navigation.
- `components/DashboardClient.tsx` - prompt input, duration picker, file input, generation actions.
- `components/ProjectsClient.tsx` - project list, episode management, saved prompts, project deletion.

### Next API Layer

- `app/api/analyze/route.ts` - accepts prompt generation requests and proxies/orchestrates generation.
- `app/api/projects/**` - project persistence proxy routes.
- `app/api/auth/**` - user auth proxy routes.
- `app/api/admin/**` - admin compatibility routes.

### NestJS API

- `apps/api/src/modules/auth` - user login, registration, password hashing, JWT/session behavior.
- `apps/api/src/modules/projects` - project creation, episode saving, memory persistence.
- `apps/api/src/modules/admin` - admin user/project/usage/log endpoints.
- `apps/api/src/modules/library` - internal library/knowledge item support.

### AI And Memory

- `lib/ai.ts` - provider calls, retry/validation, generated output structure.
- `lib/agent/video-director-graph.ts` - AI video director workflow.
- `apps/api/src/modules/projects/projects.service.ts` - saves projects, episodes, memory items, character profiles, story loops.

## Data Model Summary

Important Prisma models:

- `User` - account, plan, quota, preferences.
- `Project` - a whole story/project/series.
- `ProjectVersion` - an episode, displayed as 第 N 集.
- `StoryboardShot` - generated shot rows.
- `MemoryItem` - searchable project memory.
- `CharacterProfile` - character consistency memory.
- `StoryLoop` - open/resolved plot hooks.
- `KnowledgeItem` - reusable shot/movement/transition/style knowledge.

## Project And Episode Rules

Use these semantics consistently:

- Project = one story / one series.
- ProjectVersion = one episode.
- Global "新建生成" creates a new Project with 第 1 集.
- Inside a project, "新建一集" creates the next episode for that project.
- Editing an episode should update that episode rather than creating a different project.
- Project memory should be isolated per user and per project.

## What Future Agents Should Preserve

- Keep the normal user experience focused on `/dashboard` and `/projects`.
- Keep `fullVideoPrompt` saved exactly as generated for user copy/download/history.
- Keep local runtime ports isolated from the original project.
- Do not delete library/admin routes unless the user asks for a true code removal.
- Do not point `localdirector` back to the original project's database or Redis.

## Verification Checklist

Before saying a change is done:

```powershell
npm run typecheck
npm run api:typecheck
npm run build
```

For database-related changes, also run after Docker is started:

```powershell
npx prisma generate
npx prisma migrate deploy
```

For runtime bugs, check both:

- Next server terminal
- Nest API terminal

Most "Internal server error" cases in this project are caused by one of:

- Docker Desktop not running
- PostgreSQL not running on `55432`
- Redis not running on `56379`
- Prisma client not regenerated after schema change
- `.env` pointing to the wrong project/runtime
