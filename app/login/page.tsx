"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, LockKeyhole, Mail, Phone, RefreshCcw, ShieldCheck, UserPlus, Video, X } from "lucide-react";

type AuthMode = "login" | "register" | "reset";

type CaptchaState = {
  captchaId: string;
  image: string;
};

type CodeDialogState = {
  open: boolean;
  captcha: CaptchaState | null;
  captchaAnswer: string;
};

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get("mode") === "register" ? "register" : searchParams.get("mode") === "reset" ? "reset" : "login";
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeDialog, setCodeDialog] = useState<CodeDialogState>({
    open: false,
    captcha: null,
    captchaAnswer: "",
  });

  async function fetchCaptcha() {
    const res = await fetch("/api/auth/captcha", { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || !data?.data?.captchaId || !data?.data?.image) {
      throw new Error(data?.error || "图片验证码获取失败，请确认账号后端已启动。");
    }
    return { captchaId: data.data.captchaId, image: data.data.image };
  }

  async function openCodeCaptchaDialog() {
    const target = mode === "register" ? phone : identifier;
    if (!target.trim()) {
      setMessage(mode === "register" ? "请先输入手机号。" : "请先输入手机号或邮箱。");
      return;
    }

    setSendingCode(true);
    setMessage("");
    try {
      const captcha = await fetchCaptcha();
      setCodeDialog({ open: true, captcha, captchaAnswer: "" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片验证码获取失败，请确认账号后端已启动。");
    } finally {
      setSendingCode(false);
    }
  }

  async function refreshCodeCaptcha() {
    setMessage("");
    try {
      const captcha = await fetchCaptcha();
      setCodeDialog((current) => ({ ...current, captcha, captchaAnswer: "" }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片验证码获取失败，请确认账号后端已启动。");
    }
  }

  async function sendCodeAfterCaptcha() {
    if (!codeDialog.captcha?.captchaId || !codeDialog.captchaAnswer.trim()) {
      setMessage("请先输入图片里的数字或字母。");
      return;
    }

    const target = mode === "register" ? phone : identifier;
    const channel = target.includes("@") ? "email" : "sms";
    setSendingCode(true);
    setMessage("");
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target,
          channel,
          purpose: mode === "register" ? "register" : "reset_password",
          captchaId: codeDialog.captcha.captchaId,
          captchaAnswer: codeDialog.captchaAnswer,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "验证码发送失败。");
      setCodeDialog({ open: false, captcha: null, captchaAnswer: "" });
      setMessage(data?.data?.debugCode ? `验证码已生成：${data.data.debugCode}` : "验证码已发送。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "验证码发送失败。");
      await refreshCodeCaptcha();
    } finally {
      setSendingCode(false);
    }
  }

  function resetForm(nextMode: AuthMode) {
    setMode(nextMode);
    setMessage("");
    setPassword("");
    setConfirmPassword("");
    setSmsCode("");
    setResetCode("");
    setCodeDialog({ open: false, captcha: null, captchaAnswer: "" });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const endpoint = mode === "reset" ? "reset-password" : mode;
    const body =
      mode === "login"
        ? { identifier, password }
        : mode === "register"
          ? { phone, email, password, confirmPassword, smsCode }
          : { identifier, code: resetCode, password, confirmPassword };

    try {
      const res = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "账号服务暂时不可用，请稍后再试。");
      }
      const nextPath = searchParams.get("next");
      const safeNextPath = nextPath?.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/dashboard";
      router.push(safeNextPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号服务暂时不可用，请稍后再试。");
    } finally {
      setLoading(false);
    }
  }

  const title = mode === "login" ? "账号登录" : mode === "register" ? "创建账号" : "找回密码";
  const submitText = mode === "login" ? "登录工作台" : mode === "register" ? "注册并进入工作台" : "重置并登录";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="glass-panel neon-border relative w-full max-w-md rounded-2xl p-8">
        <a href="/" className="mb-8 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200 shadow-neon">
            <Video className="h-5 w-5" />
          </div>
          <div>
            <div className="font-bold text-white">AI Video Director</div>
            <div className="text-xs text-cyan-100/55">账号中心</div>
          </div>
        </a>

        <div className="mb-6 grid grid-cols-3 rounded-2xl border border-cyan-300/15 bg-slate-950/55 p-1">
          {(["login", "register", "reset"] as AuthMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => resetForm(item)}
              className={`rounded-xl px-3 py-2 text-sm font-bold transition ${mode === item ? "bg-cyan-300 text-slate-950" : "text-slate-300 hover:text-white"}`}
            >
              {item === "login" ? "登录" : item === "register" ? "注册" : "找回"}
            </button>
          ))}
        </div>

        <h1 className="text-3xl font-black text-white">{title}</h1>

        {mode !== "register" && (
          <label className="relative mt-6 block">
            <Mail className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
            <input
              name="identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              type="text"
              required
              autoComplete="username"
              placeholder="手机号或邮箱"
              className="control-input w-full rounded-xl py-3 pl-11 pr-4"
            />
          </label>
        )}

        {mode === "register" && (
          <>
            <label className="relative mt-6 block">
              <Phone className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
              <input
                name="phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                type="tel"
                required
                autoComplete="tel"
                placeholder="手机号"
                className="control-input w-full rounded-xl py-3 pl-11 pr-4"
              />
            </label>

            <label className="relative mt-4 block">
              <Mail className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                required
                autoComplete="email"
                placeholder="绑定邮箱"
                className="control-input w-full rounded-xl py-3 pl-11 pr-4"
              />
            </label>
          </>
        )}

        {(mode === "register" || mode === "reset") && (
          <div className="mt-4 flex gap-3">
            <label className="relative block flex-1">
              <KeyRound className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
              <input
                name={mode === "register" ? "smsCode" : "resetCode"}
                value={mode === "register" ? smsCode : resetCode}
                onChange={(event) => (mode === "register" ? setSmsCode(event.target.value) : setResetCode(event.target.value))}
                type="text"
                required
                inputMode="numeric"
                placeholder={mode === "register" ? "手机验证码" : "验证码"}
                className="control-input w-full rounded-xl py-3 pl-11 pr-4"
              />
            </label>
            <button
              type="button"
              disabled={sendingCode}
              onClick={openCodeCaptchaDialog}
              className="muted-button min-w-28 rounded-xl px-4 text-sm font-bold disabled:opacity-60"
            >
              {sendingCode ? "处理中" : "获取验证码"}
            </button>
          </div>
        )}

        <label className="relative mt-4 block">
          <LockKeyhole className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="至少 8 位密码"
            className="control-input w-full rounded-xl py-3 pl-11 pr-4"
          />
        </label>

        {mode !== "login" && (
          <label className="relative mt-4 block">
            <LockKeyhole className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="再次输入密码"
              className="control-input w-full rounded-xl py-3 pl-11 pr-4"
            />
          </label>
        )}

        <button
          type="submit"
          disabled={loading}
          className="primary-neon mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-4 font-bold disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UserPlus className="h-4 w-4" />
          {loading ? "处理中..." : submitText}
        </button>

        {message && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm leading-6 text-red-100">{message}</p>}

        {codeDialog.open && (
          <div className="absolute inset-0 z-20 grid place-items-center rounded-2xl bg-slate-950/82 p-5 backdrop-blur-sm">
            <div className="w-full rounded-2xl border border-cyan-300/20 bg-slate-950 p-5 shadow-neon">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="text-base font-bold text-white">图形验证码</div>
                  <div className="mt-1 text-xs text-slate-400">输入图片里的数字或字母后再发送验证码。</div>
                </div>
                <button
                  type="button"
                  onClick={() => setCodeDialog({ open: false, captcha: null, captchaAnswer: "" })}
                  className="muted-button grid h-9 w-9 place-items-center rounded-xl"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex gap-3">
                <div className="flex h-14 flex-1 items-center justify-center overflow-hidden rounded-xl border border-cyan-300/20 bg-slate-950/70">
                  {codeDialog.captcha?.image ? (
                    <img src={codeDialog.captcha.image} alt="captcha" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-sm text-slate-500">验证码准备中</span>
                  )}
                </div>
                <button type="button" onClick={refreshCodeCaptcha} className="muted-button grid min-h-14 place-items-center rounded-xl px-4">
                  <RefreshCcw className="h-4 w-4" />
                </button>
              </div>

              <label className="relative mt-4 block">
                <ShieldCheck className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/55" />
                <input
                  value={codeDialog.captchaAnswer}
                  onChange={(event) => setCodeDialog((current) => ({ ...current, captchaAnswer: event.target.value }))}
                  type="text"
                  autoFocus
                  required
                  placeholder="输入图片里的数字或字母"
                  className="control-input w-full rounded-xl py-3 pl-11 pr-4"
                />
              </label>

              <button
                type="button"
                disabled={sendingCode}
                onClick={sendCodeAfterCaptcha}
                className="primary-neon mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 font-bold disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ShieldCheck className="h-4 w-4" />
                {sendingCode ? "发送中..." : "确认并发送验证码"}
              </button>
            </div>
          </div>
        )}
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="glass-panel neon-border w-full max-w-md rounded-2xl p-8 text-sm text-slate-300">
            加载账号中心...
          </div>
        </main>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
