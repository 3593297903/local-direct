import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("frontend login uses the NestJS auth proxy instead of Supabase magic links", () => {
  const loginPage = readFileSync("app/login/page.tsx", "utf8");

  assert.doesNotMatch(loginPage, /supabase/i);
  assert.match(loginPage, /type="password"/);
  assert.match(loginPage, /identifier/);
  assert.match(loginPage, /phone/);
  assert.match(loginPage, /captcha/);
  assert.match(loginPage, /smsCode/);
  assert.match(loginPage, /confirmPassword/);
  assert.match(loginPage, /reset-password/);
  assert.match(loginPage, /codeDialog/);
  assert.match(loginPage, /openCodeCaptchaDialog/);
  assert.match(loginPage, /sendCodeAfterCaptcha/);
  assert.match(loginPage, /purpose: mode === "register" \? "register" : "reset_password"/);
  assert.doesNotMatch(loginPage, /useEffect/);
  assert.doesNotMatch(loginPage, /加载验证码/);
  assert.match(loginPage, /searchParams\.get\("next"\)/);
  assert.match(loginPage, /router\.push\(safeNextPath\)/);
  assert.doesNotMatch(loginPage, /邮箱密码登录/);
  assert.doesNotMatch(loginPage, /NestJS 账号系统/);
  assert.doesNotMatch(loginPage, /HttpOnly/);
});

test("Next auth proxy routes store the NestJS JWT in an HttpOnly cookie", () => {
  const helperPath = "lib/nest-auth-proxy.ts";
  assert.equal(existsSync(helperPath), true);

  const helper = readFileSync(helperPath, "utf8");
  assert.match(helper, /NEST_AUTH_TOKEN_COOKIE/);
  assert.match(helper, /httpOnly: true/);
  assert.match(helper, /sameSite: "lax"/);
  assert.match(helper, /NEST_API_BASE_URL/);
  assert.match(helper, /Authorization.*Bearer/);
  assert.match(helper, /Auth service is unavailable/);
  assert.match(helper, /catch \(error\)/);

  for (const route of ["login", "register", "me", "logout", "captcha", "send-code", "reset-password"]) {
    const routePath = `app/api/auth/${route}/route.ts`;
    assert.equal(existsSync(routePath), true, `${routePath} should exist`);
  }

  const loginRoute = readFileSync("app/api/auth/login/route.ts", "utf8");
  const registerRoute = readFileSync("app/api/auth/register/route.ts", "utf8");
  const captchaRoute = readFileSync("app/api/auth/captcha/route.ts", "utf8");
  const sendCodeRoute = readFileSync("app/api/auth/send-code/route.ts", "utf8");
  const resetPasswordRoute = readFileSync("app/api/auth/reset-password/route.ts", "utf8");
  const meRoute = readFileSync("app/api/auth/me/route.ts", "utf8");
  const logoutRoute = readFileSync("app/api/auth/logout/route.ts", "utf8");

  assert.match(loginRoute, /proxyNestAuthWithBody\(request, "login"\)/);
  assert.match(registerRoute, /proxyNestAuthWithBody\(request, "register"\)/);
  assert.match(captchaRoute, /proxyNestAuthGet\("captcha"\)/);
  assert.match(sendCodeRoute, /proxyNestAuthPlainBody\(request, "send-code"\)/);
  assert.match(resetPasswordRoute, /proxyNestAuthWithBody\(request, "reset-password"\)/);
  assert.match(meRoute, /proxyNestAuthMe\(request\)/);
  assert.match(logoutRoute, /clearNestAuthCookie/);
});

test("auth cookies are secure only when the configured app URL is HTTPS", () => {
  const helper = readFileSync("lib/cookie-security.ts", "utf8");
  const authProxy = readFileSync("lib/nest-auth-proxy.ts", "utf8");
  const adminLogin = readFileSync("app/api/admin/login/route.ts", "utf8");
  const adminLogout = readFileSync("app/api/admin/logout/route.ts", "utf8");

  assert.match(helper, /NEXT_PUBLIC_APP_URL/);
  assert.match(helper, /protocol === "https:"/);
  assert.match(helper, /AUTH_COOKIE_SECURE/);
  assert.match(authProxy, /secure: shouldUseSecureCookie\(\)/);
  assert.match(adminLogin, /secure: shouldUseSecureCookie\(\)/);
  assert.match(adminLogout, /secure: shouldUseSecureCookie\(\)/);
  assert.doesNotMatch(authProxy, /secure: process\.env\.NODE_ENV === "production"/);
});
