import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../scripts/auth-password.mjs";

test("password hashing stores salted hashes and verifies without keeping plaintext", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.notEqual(first, "correct horse battery staple");
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("NestJS auth module exposes register, login, and protected current-user endpoints", () => {
  const controller = readFileSync("apps/api/src/modules/auth/auth.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/auth/auth.service.ts", "utf8");
  const module = readFileSync("apps/api/src/modules/auth/auth.module.ts", "utf8");
  const guard = readFileSync("apps/api/src/modules/auth/jwt-auth.guard.ts", "utf8");

  assert.match(controller, /@Post\("register"\)/);
  assert.match(controller, /@Post\("login"\)/);
  assert.match(controller, /@UseGuards\(JwtAuthGuard\)/);
  assert.match(controller, /@Get\("me"\)/);
  assert.match(service, /prisma\.user\.create/);
  assert.match(service, /prisma\.user\.findFirst/);
  assert.match(service, /signAsync/);
  assert.match(module, /JwtModule\.registerAsync/);
  assert.match(guard, /Authorization/);
});

test("auth schema stores reusable phone and email verification codes", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /model VerificationCode \{/);
  assert.match(schema, /target\s+String/);
  assert.match(schema, /channel\s+String/);
  assert.match(schema, /purpose\s+String/);
  assert.match(schema, /codeHash\s+String/);
  assert.match(schema, /@@index\(\[target, channel, purpose, expiresAt\]\)/);
  assert.doesNotMatch(schema, /model SmsCode \{/);
});

test("NestJS auth supports captcha, phone-code registration, identifier login, and password reset", () => {
  const controller = readFileSync("apps/api/src/modules/auth/auth.controller.ts", "utf8");
  const service = readFileSync("apps/api/src/modules/auth/auth.service.ts", "utf8");
  const dto = readFileSync("apps/api/src/modules/auth/auth.dto.ts", "utf8");

  assert.match(controller, /@Get\("captcha"\)/);
  assert.match(controller, /@Post\("send-code"\)/);
  assert.match(controller, /@Post\("reset-password"\)/);

  assert.match(dto, /class SendCodeDto/);
  assert.match(dto, /class ResetPasswordDto/);
  assert.match(dto, /identifier/);
  assert.match(dto, /confirmPassword/);
  assert.match(dto, /captchaId/);
  assert.match(dto, /captchaAnswer/);
  assert.match(dto, /smsCode/);

  assert.match(service, /generateCaptcha/);
  assert.match(service, /sendCode/);
  assert.match(service, /resetPassword/);
  assert.match(service, /verifyCaptcha/);
  assert.match(service, /verifyAndConsumeCode/);
  assert.match(service, /this\.verifyCaptcha\(input\.captchaId, input\.captchaAnswer\);/);
  assert.doesNotMatch(service, /input\.purpose === "register"/);
  assert.match(service, /OR: \[\{ email: identifier \}, \{ phone: identifier \}\]/);
});

test("auth responses never expose passwordHash", () => {
  const service = readFileSync("apps/api/src/modules/auth/auth.service.ts", "utf8");

  assert.match(service, /passwordHash: _passwordHash/);
  assert.match(service, /return rest/);
  assert.doesNotMatch(service, /passwordHash,\s*accessToken/);
});
