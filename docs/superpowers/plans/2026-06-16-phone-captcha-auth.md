# Phone Captcha Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the email-only login/register flow with phone-first registration that requires an image captcha and a phone verification code, while keeping email or phone password login and code-based password reset.

**Architecture:** NestJS owns captcha generation, verification-code creation, registration, login, and reset-password behavior. Next.js keeps HttpOnly session cookie behavior through proxy routes and renders the login/register/reset UI.

**Tech Stack:** Next.js App Router, NestJS, Prisma/PostgreSQL, class-validator, Node crypto.

---

### Task 1: Auth Data And Endpoint Tests

**Files:**
- Modify: `test/auth-prisma-migration.test.mjs`
- Modify: `test/frontend-nest-auth.test.mjs`

- [ ] Write failing tests for `VerificationCode`, captcha/send-code/reset-password endpoints, phone/email identifier login, and removal of old login explanatory copy.
- [ ] Run focused tests and confirm they fail because the new behavior is missing.

### Task 2: NestJS Auth Behavior

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `apps/api/src/modules/auth/auth.dto.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.service.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Create: `apps/api/src/modules/auth/code-utils.ts`

- [ ] Add `VerificationCode` model for sms/email code storage.
- [ ] Add DTOs for captcha, send-code, reset-password, phone registration, and identifier login.
- [ ] Generate SVG captcha as data URL, verify captcha before sending phone codes, store hashed verification codes, and mark codes used.
- [ ] Register with phone + phone code + email + password confirmation, then return a JWT.
- [ ] Login with either email or phone.
- [ ] Reset password with an sms/email code.

### Task 3: Next Proxy And UI

**Files:**
- Modify: `lib/nest-auth-proxy.ts`
- Create: `app/api/auth/captcha/route.ts`
- Create: `app/api/auth/send-code/route.ts`
- Create: `app/api/auth/reset-password/route.ts`
- Modify: `app/login/page.tsx`

- [ ] Proxy captcha/send-code/reset-password requests to Nest.
- [ ] Keep login/register token-setting behavior for responses that include `accessToken`.
- [ ] Replace the old login page copy with a cleaner account form.
- [ ] Add login, register, and forgot-password modes.
- [ ] Add captcha image refresh, phone code sending, password confirmation, and user-facing errors.

### Task 4: Verification

**Files:**
- Test commands only.

- [ ] Run `node --test test/auth-prisma-migration.test.mjs test/frontend-nest-auth.test.mjs`.
- [ ] Run `npm run api:typecheck`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
