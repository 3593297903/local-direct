# NestJS Prisma Redis Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel NestJS API skeleton with Prisma, PostgreSQL, Redis, and BullMQ without replacing the current Next.js API routes.

**Architecture:** Keep the existing Next.js application operational while adding `apps/api` as a separate backend service. Prisma defines the future SaaS database model, Redis/BullMQ provides the async-job foundation, and placeholder modules establish stable boundaries for later migrations.

**Tech Stack:** Next.js frontend, NestJS API, Prisma ORM, PostgreSQL, Redis, BullMQ, TypeScript.

---

### Task 1: Backend Skeleton

**Files:**
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/modules/*`
- Create: `apps/api/src/prisma/*`
- Create: `apps/api/src/queue/*`

- [x] Add a standalone NestJS API with global prefix `/api`.
- [x] Add health, auth, users, projects, library, ai, jobs, media, usage, and admin module boundaries.
- [x] Add Prisma service without forcing DB connection on boot.
- [x] Add BullMQ root config from `REDIS_URL`.

### Task 2: Data and Infrastructure

**Files:**
- Create: `prisma/schema.prisma`
- Create: `docker-compose.yml`
- Create: `.env.api.example`

- [x] Define User, Project, StoryboardShot, LibraryItem, MediaAsset, Favorite, Job, JobLog, UsageEvent, and SmsCode models.
- [x] Add local PostgreSQL and Redis services.
- [x] Document API-specific environment variables.

### Task 3: Package Scripts and Verification

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `test/api-skeleton.test.mjs`

- [x] Add NestJS, Prisma, Redis, and validation dependencies.
- [x] Add `api:dev`, `api:build`, `api:start`, `api:typecheck`, `prisma:generate`, and `docker:up` scripts.
- [x] Keep root Next.js typecheck from compiling `apps/api`.
- [x] Add a structural test proving skeleton files and scripts exist.
- [x] Run `npm run prisma:generate`, `npm run api:typecheck`, and `npm test`.

### Task 4: First Library Migration Step

**Files:**
- Create: `scripts/knowledge-item-prisma-mapper.mjs`
- Create: `scripts/import-knowledge-items-to-prisma.mjs`
- Create: `apps/api/src/modules/library/library.service.ts`
- Create: `apps/api/src/modules/library/library.types.ts`
- Modify: `apps/api/src/modules/library/library.controller.ts`
- Modify: `apps/api/src/modules/library/library.module.ts`
- Test: `test/library-prisma-migration.test.mjs`

- [x] Add JSON-to-Prisma and Prisma-to-frontend mapping for knowledge library items.
- [x] Add a `library:import` script for importing `data/knowledge-items.json` into PostgreSQL.
- [x] Replace the NestJS library placeholder response with a Prisma-backed service.
- [x] Preserve frontend-compatible `type`, `tags`, `previewUrl`, `posterUrl`, `order`, and search behavior.
- [x] Verify with `npm run prisma:generate`, `npm run api:typecheck`, `npm run api:build`, `npm run typecheck`, and `npm test`.
- [x] After Docker/PostgreSQL is available locally, run `npm run docker:up`, `npm run prisma:migrate`, and `npm run library:import`.

### Task 5: First Projects Migration Step

**Files:**
- Create: `scripts/project-prisma-mapper.mjs`
- Create: `apps/api/src/modules/projects/projects.dto.ts`
- Create: `apps/api/src/modules/projects/projects.service.ts`
- Modify: `apps/api/src/modules/projects/projects.controller.ts`
- Modify: `apps/api/src/modules/projects/projects.module.ts`
- Test: `test/projects-prisma-migration.test.mjs`

- [x] Add analysis-result-to-Prisma mapping for project and storyboard shot creation.
- [x] Add frontend-compatible project summary mapping.
- [x] Replace the NestJS projects placeholder response with a Prisma-backed service.
- [x] Add `GET /api/projects?userId=...` and `POST /api/projects` in the NestJS API.
- [x] Keep the existing Next.js `app/api/projects` route untouched until auth migration is ready.
- [x] Verify with `node --test test/projects-prisma-migration.test.mjs` and `npm run api:typecheck`.

### Task 6: Auth Foundation

**Files:**
- Create: `scripts/auth-password.mjs`
- Create: `apps/api/src/modules/auth/password.ts`
- Create: `apps/api/src/modules/auth/auth.dto.ts`
- Create: `apps/api/src/modules/auth/auth.service.ts`
- Create: `apps/api/src/modules/auth/jwt-auth.guard.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Modify: `.env.api.example`
- Test: `test/auth-prisma-migration.test.mjs`

- [x] Add salted `scrypt` password hashing and verification.
- [x] Add `POST /api/auth/register` for email/password registration.
- [x] Add `POST /api/auth/login` for email/password login.
- [x] Add JWT access token generation with configurable `JWT_SECRET` and `JWT_EXPIRES_IN`.
- [x] Add `JwtAuthGuard` and protected `GET /api/auth/me`.
- [x] Ensure auth responses do not expose `passwordHash`.
- [x] Keep the existing Next.js/Supabase login flow untouched until frontend auth migration is ready.

### Task 7: Project Ownership via JWT

**Files:**
- Modify: `apps/api/src/modules/projects/projects.controller.ts`
- Modify: `apps/api/src/modules/projects/projects.service.ts`
- Modify: `apps/api/src/modules/projects/projects.dto.ts`
- Modify: `apps/api/src/modules/projects/projects.module.ts`
- Test: `test/projects-prisma-migration.test.mjs`

- [x] Protect NestJS project routes with `JwtAuthGuard`.
- [x] Read project ownership from `request.user.id` instead of `?userId=...`.
- [x] Remove `userId` from project create request bodies.
- [x] Import `AuthModule` into `ProjectsModule` so the guard can be resolved.
- [x] Verify with `node --test test/projects-prisma-migration.test.mjs`.

### Task 8: Frontend Login via NestJS Auth

**Files:**
- Create: `lib/nest-auth-proxy.ts`
- Create: `app/api/auth/login/route.ts`
- Create: `app/api/auth/register/route.ts`
- Create: `app/api/auth/me/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Modify: `app/login/page.tsx`
- Modify: `.env.api.example`
- Test: `test/frontend-nest-auth.test.mjs`

- [x] Replace Supabase magic-link login UI with email/password login and registration.
- [x] Proxy frontend auth calls through same-origin Next routes.
- [x] Store the NestJS JWT in an HttpOnly cookie instead of exposing it to client JavaScript.
- [x] Add `NEST_API_BASE_URL` so the frontend proxy can target the NestJS API.
- [x] Keep admin library login separate from normal user login.
- [x] Verify with `node --test test/frontend-nest-auth.test.mjs`.

### Task 9: Local Infrastructure Verification

**Files:**
- Create: `scripts/check-api-infra.mjs`
- Modify: `package.json`
- Test: `test/api-infra-check.test.mjs`

- [x] Add `npm run infra:check` to inspect Docker, Docker Compose, PostgreSQL, and Redis availability.
- [x] Make the check script safe to run without Docker and able to emit JSON diagnostics.
- [x] Document the expected real-DB startup sequence: `npm run docker:up`, `npm run prisma:migrate`, `npm run library:import`, `npm run api:dev`.
- [x] Verify with `node --test test/api-infra-check.test.mjs`.
- [x] Run the real Docker/PostgreSQL/Redis stack after Docker Desktop is installed on this machine.
- [x] Verify NestJS API can read PostgreSQL library data over HTTP.

### Task 10: Frontend Projects via NestJS Auth

**Files:**
- Create: `lib/nest-projects-proxy.ts`
- Modify: `app/api/projects/route.ts`
- Modify: `app/api/analyze/route.ts`
- Modify: `components/DashboardClient.tsx`
- Test: `test/frontend-nest-projects.test.mjs`
- Test: `test/analyze-nest-project-save.test.mjs`
- Test: `test/dashboard-project-save.test.mjs`

- [x] Replace the Supabase-backed `app/api/projects` route with a same-origin proxy to NestJS `GET /api/projects` and `POST /api/projects`.
- [x] Forward the HttpOnly NestJS auth cookie as a Bearer token when reading or writing projects.
- [x] Map generated analysis results into the NestJS project create body.
- [x] Save generated Dashboard results through NestJS when analysis requests `save: true`.
- [x] Keep generation usable when no user is logged in by returning `{ saved: false }` instead of failing the analysis.
- [x] Verify with focused tests, Next typecheck, Nest API typecheck, and the full test suite.
