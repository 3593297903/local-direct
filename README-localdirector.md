# Local Director

Local Director is a portable copy of AI Video Director focused on two user-facing work areas:

- Dashboard: generate AI video prompts, storyboard tables, DOCX output, and project episodes.
- My Projects: continue saved projects, create new episodes, review full video prompts, and manage project history.

The library, shot, motion, transition, style, and admin material routes are kept in the codebase for compatibility, but they are not exposed in the main user navigation. This keeps the app usable while preserving the generation pipeline that may still read internal knowledge and reference data.

## Move To Another Computer

Install these first:

- Node.js 22 LTS or newer
- Docker Desktop
- Git, optional but recommended

Then copy the full `localdirector` folder to the new computer.

Run:

```powershell
cd E:\localdirector
npm run local:start
```

The setup script will:

- create `.env` from `.env.example` if missing
- install npm dependencies when `node_modules` is missing
- start PostgreSQL and Redis with Docker
- generate the Prisma client
- apply database migrations

Then start the app in two terminals:

```powershell
cd E:\localdirector
npm run api:dev
```

```powershell
cd E:\localdirector
npm run dev:local
```

If you want Dashboard storyboard images to use the local Codex Image Gen workflow, start a third terminal after the frontend is running:

```powershell
cd E:\localdirector
npm run storyboard:codex-worker
```

For the full generation workflow, start all local Codex workers in one terminal:

```powershell
npm run codex:workers
```

This worker claims local storyboard panel tasks from the Next.js app, runs `codex exec`, asks Codex to use `$imagegen`, and saves PNG panels under `public/project-assets/storyboards`. It requires the Codex CLI to be installed and logged in on the same machine.

By default the worker runs up to 5 storyboard panel generations in parallel. You can tune it in `.env.local`:

```text
STORYBOARD_CODEX_CONCURRENCY=5
STORYBOARD_CODEX_POLL_MS=1000
STORYBOARD_CODEX_TASK_TIMEOUT_MS=1800000
```

Open:

- `http://localhost:3100/dashboard`
- `http://localhost:3100/projects`

## Environment

Before real use, edit `.env` and set:

- `AI_PROVIDER`
- `AI_MODEL`
- `AI_API_KEY`
- `AI_BASE_URL`
- `IMAGE_PROVIDER`
- `IMAGE_API_KEY`, only if you want to use the older direct image API fallback
- `ADMIN_LIBRARY_USERNAME`
- `ADMIN_LIBRARY_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `JWT_SECRET`

For local Docker, the default database values are:

```text
API_PORT=4100
NEST_API_BASE_URL=http://localhost:4100/api
DATABASE_URL=postgresql://localdirector:localdirector_dev@localhost:55432/localdirector?schema=public
REDIS_URL=redis://localhost:56379
```

The Docker services use separate names and ports from the original project:

- PostgreSQL container: `localdirector-postgres`, host port `55432`
- Redis container: `localdirector-redis`, host port `56379`
- PostgreSQL volume: `localdirector_postgres`
- Redis volume: `localdirector_redis`
- Nest API: `http://localhost:4100/api`
- Next.js frontend: `http://localhost:3100`

## What This Copy Keeps

- Next.js frontend
- NestJS API
- Prisma schema and migrations
- PostgreSQL and Redis Docker compose
- Login and user project history
- Project episodes and narrative memory
- Prompt generation, storyboard table generation, and DOCX export

## What The Main UI Shows

- 工作台
- 我的项目

Other library and admin pages remain available in code for internal compatibility, but the user sidebar and home page do not link to them.
