"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  ClipboardList,
  FolderOpen,
  Layers,
  LayoutDashboard,
  Loader2,
  LogOut,
  ShieldCheck,
  Users,
} from "lucide-react";

type GateState = "loading" | "login" | "ready";

type AdminUser = {
  id?: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  plan?: string | null;
  source?: "local" | "database";
};

const navItems = [
  { name: "仪表盘", href: "/admin", icon: LayoutDashboard },
  { name: "用户管理", href: "/admin/users", icon: Users },
  { name: "项目管理", href: "/admin/projects", icon: FolderOpen },
  { name: "用量额度", href: "/admin/usage", icon: BarChart3 },
  { name: "生成日志", href: "/admin/logs", icon: ClipboardList },
  { name: "素材库", href: "/admin/library", icon: Layers },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let active = true;

    async function checkAdminSession() {
      try {
        const localResponse = await fetch("/api/admin/session", { cache: "no-store" });
        const localData = await localResponse.json().catch(() => null);
        if (!active) return;
        if (localResponse.ok && localData?.authenticated) {
          setUser({ id: "local-admin", role: "ADMIN", source: "local" });
          setState("ready");
          return;
        }

        const userResponse = await fetch("/api/auth/me", { cache: "no-store" });
        const userData = await userResponse.json().catch(() => null);
        if (!active) return;
        const me: AdminUser | null = userResponse.ok && userData?.ok ? userData.user || null : null;
        if (me?.role === "ADMIN") {
          setUser({ ...me, source: "database" });
          setState("ready");
          return;
        }
      } catch {
        // Fall through to login.
      }

      if (active) setState("login");
    }

    checkAdminSession();
    return () => {
      active = false;
    };
  }, [pathname]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setError(data?.error || "账号或密码不正确");
        return;
      }

      setUser({ id: username || "local-admin", role: "ADMIN", source: "local" });
      setState("ready");
    } catch {
      setError("后台登录服务暂时不可用");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    await Promise.allSettled([
      fetch("/api/admin/logout", { method: "POST" }),
      fetch("/api/auth/logout", { method: "POST" }),
    ]);
    setUser(null);
    setState("login");
    router.refresh();
  }

  if (state === "loading") {
    return (
      <main className="grid min-h-screen place-items-center text-slate-300">
        <div className="inline-flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950/70 px-5 py-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在校验管理员身份...
        </div>
      </main>
    );
  }

  if (state === "login") {
    return (
      <main className="grid min-h-screen place-items-center px-6 text-slate-100">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-md rounded-2xl border border-cyan-400/30 bg-slate-950/85 p-6 shadow-[0_0_40px_rgba(8,145,178,0.16)]"
        >
          <div className="mb-6 flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10">
              <ShieldCheck className="h-5 w-5 text-cyan-200" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Admin Login</p>
              <h1 className="text-2xl font-black text-white">登录后台</h1>
            </div>
          </div>

          <div className="space-y-3">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm text-white outline-none transition focus:border-cyan-300"
              placeholder="管理员账号"
              autoComplete="username"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm text-white outline-none transition focus:border-cyan-300"
              placeholder="管理员密码"
              type="password"
              autoComplete="current-password"
            />
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-cyan-300 to-blue-600 text-sm font-black text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "登录中..." : "登录后台"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="min-h-screen text-slate-100">
      <div className="grid min-h-screen grid-cols-[220px_1fr]">
        <aside className="flex flex-col border-r border-white/10 bg-slate-950/75 p-4">
          <div className="mb-6 flex items-center gap-2 px-2 text-sm font-black text-white">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-500 text-white shadow-[0_0_18px_rgba(139,92,246,0.45)]">
              <ShieldCheck className="h-4 w-4" />
            </span>
            运营后台
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <a
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    active ? "bg-violet-400/20 text-white" : "text-slate-300 hover:bg-white/[0.06]"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.name}
                </a>
              );
            })}
          </nav>
          <div className="mt-auto space-y-3 px-2 pt-6">
            <div className="truncate text-xs text-slate-500">{user?.email || user?.phone || user?.id || "admin"}</div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              退出登录
            </button>
          </div>
        </aside>
        <section className="p-8">{children}</section>
      </div>
    </div>
  );
}
