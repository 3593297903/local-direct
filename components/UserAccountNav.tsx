"use client";

import { useEffect, useRef, useState } from "react";
import { LogIn, LogOut, UserRound, UserPlus } from "lucide-react";

type AuthUser = {
  email?: string | null;
  phone?: string | null;
  plan?: string | null;
};

type UserAccountNavProps = {
  compact?: boolean;
};

export function UserAccountNav({ compact = false }: UserAccountNavProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isAuthenticated = Boolean(user);
  const displayName = user ? user.email || user.phone || "已登录用户" : "";

  useEffect(() => {
    let active = true;

    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!active) return;
        setUser(response.ok && data?.ok ? data.user || null : null);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function closeFromOutside(event: MouseEvent) {
      if (!rootRef.current || rootRef.current.contains(event.target as Node)) return;
      setMenuOpen(false);
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    setMenuOpen(false);
    setUser(null);
    window.location.reload();
  }

  if (loading) {
    return (
      <div className="inline-flex h-10 items-center rounded-xl border border-white/10 bg-slate-950/55 px-4 text-sm text-slate-400">
        账号状态...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <nav className="pointer-events-auto relative z-50 flex items-center gap-2" aria-label="用户账号入口">
        <a
          href="/login"
          className="inline-flex items-center gap-2 rounded-xl border border-cyan-200/18 bg-slate-950/80 px-4 py-2 text-sm font-semibold text-cyan-50 shadow-[0_12px_34px_rgba(0,0,0,0.24)] backdrop-blur-xl transition hover:border-cyan-200/42 hover:bg-slate-900/95 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/40"
        >
          <LogIn className="h-4 w-4" />
          登录
        </a>
        {!compact && (
          <a
            href="/login?mode=register"
            className="primary-neon inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-cyan-300/45"
          >
            <UserPlus className="h-4 w-4" />
            注册
          </a>
        )}
      </nav>
    );
  }

  return (
    <div ref={rootRef} className="group/account relative z-50">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
        className="inline-flex max-w-[260px] items-center gap-2 rounded-xl border border-white/55 bg-slate-950/72 px-3 py-2 text-sm font-semibold text-slate-100 shadow-[0_14px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl transition hover:border-white/75 hover:bg-slate-900/90"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-violet-500 text-white shadow-[0_0_18px_rgba(139,92,246,0.45)]">
          <UserRound className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate">{displayName}</span>
        {user?.plan && <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-cyan-100/75">{user.plan}</span>}
      </button>

      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-100 px-2 py-1 text-xs font-bold text-zinc-950 opacity-0 shadow-lg transition group-hover/account:opacity-100">
        用户中心
      </div>

      {menuOpen && (
      <div
        role="menu"
        className="absolute right-0 top-full z-50 mt-2 w-44 rounded-xl border border-cyan-300/14 bg-slate-950/95 p-2 opacity-100 shadow-[0_20px_70px_rgba(0,0,0,0.46)] backdrop-blur-xl"
      >
        <button
          type="button"
          role="menuitem"
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </button>
      </div>
      )}
    </div>
  );
}
