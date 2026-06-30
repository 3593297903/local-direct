"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Power, Save, Search, Trash2, UserPlus, X } from "lucide-react";
import { AdminShell } from "@/components/AdminShell";

type Role = "USER" | "ADMIN";
type Plan = "FREE" | "PRO";
type Status = "ACTIVE" | "DISABLED";

type AdminUserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  role: Role;
  plan: Plan;
  status: Status;
  credits: number;
  dailyLimit: number;
  lastLoginAt: string | null;
  loginCount: number;
  note: string | null;
  projectCount: number;
  createdAt: string;
};

type ListResponse = {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function displayName(user: AdminUserRow) {
  return user.email || user.phone || user.id.slice(0, 8);
}

function CreateUserModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function onSubmit() {
    setMessage("");
    if (!email.trim() && !phone.trim()) {
      setMessage("邮箱和手机号至少填写一个");
      return;
    }
    if (password.length < 8) {
      setMessage("密码至少 8 位");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          password,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "新增用户失败");
      onSaved();
      onClose();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "新增用户失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="admin-modal-panel w-full max-w-lg rounded-2xl p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase text-cyan-200/70">Create User</p>
            <h3 className="mt-1 text-xl font-black text-white">新增用户</h3>
            <p className="mt-1 text-xs text-slate-400">默认创建为 USER / FREE / 正常，密码会在后端自动加密。</p>
          </div>
          <button onClick={onClose} className="rounded-xl border border-white/10 p-2 text-slate-300 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          <label className="space-y-1.5">
            <span className="font-semibold text-white">手机号</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="例如：13800138001"
              className="control-input w-full rounded-xl px-3 py-2.5"
            />
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">邮箱</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="例如：user@example.com"
              className="control-input w-full rounded-xl px-3 py-2.5"
            />
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">密码</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="至少 8 位"
              className="control-input w-full rounded-xl px-3 py-2.5"
            />
          </label>
        </div>

        {message && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{message}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="muted-button rounded-xl px-5 py-2.5 text-sm font-bold">
            取消
          </button>
          <button onClick={onSubmit} disabled={saving} className="primary-neon inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-60">
            <UserPlus className="h-4 w-4" /> {saving ? "创建中..." : "创建用户"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<Role>(user.role);
  const [plan, setPlan] = useState<Plan>(user.plan);
  const [status, setStatus] = useState<Status>(user.status);
  const [credits, setCredits] = useState(String(user.credits));
  const [dailyLimit, setDailyLimit] = useState(String(user.dailyLimit));
  const [note, setNote] = useState(user.note || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function onSubmit() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          plan,
          status,
          credits: Number(credits) || 0,
          dailyLimit: Number(dailyLimit) || 0,
          note,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "保存失败");
      onSaved();
      onClose();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="admin-modal-panel w-full max-w-lg rounded-2xl p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase text-cyan-200/70">Edit User</p>
            <h3 className="mt-1 text-xl font-black text-white">{displayName(user)}</h3>
          </div>
          <button onClick={onClose} className="rounded-xl border border-white/10 p-2 text-slate-300 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <label className="space-y-1.5">
            <span className="font-semibold text-white">套餐</span>
            <select value={plan} onChange={(e) => setPlan(e.target.value as Plan)} className="control-input w-full rounded-xl px-3 py-2.5">
              <option value="FREE">FREE</option>
              <option value="PRO">PRO</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">角色</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="control-input w-full rounded-xl px-3 py-2.5">
              <option value="USER">USER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">状态</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className="control-input w-full rounded-xl px-3 py-2.5">
              <option value="ACTIVE">正常</option>
              <option value="DISABLED">停用</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">积分</span>
            <input type="number" min="0" value={credits} onChange={(e) => setCredits(e.target.value)} className="control-input w-full rounded-xl px-3 py-2.5" />
          </label>
          <label className="space-y-1.5">
            <span className="font-semibold text-white">每日上限</span>
            <input type="number" min="0" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className="control-input w-full rounded-xl px-3 py-2.5" />
          </label>
          <label className="col-span-2 space-y-1.5">
            <span className="font-semibold text-white">管理员备注（用户不可见）</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} className="control-input h-20 w-full rounded-xl px-3 py-2.5" />
          </label>
        </div>

        {message && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{message}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose} className="muted-button rounded-xl px-5 py-2.5 text-sm font-bold">
            取消
          </button>
          <button onClick={onSubmit} disabled={saving} className="primary-neon inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-60">
            <Save className="h-4 w-4" /> {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 20, pageCount: 1 });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | Status>("");
  const [plan, setPlan] = useState<"" | Plan>("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      if (plan) params.set("plan", plan);
      params.set("page", String(page));
      params.set("pageSize", "20");
      const res = await fetch(`/api/admin/users?${params.toString()}`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "加载用户列表失败");
      const data: ListResponse = json.data;
      setRows(data.users || []);
      setMeta({ total: data.total, page: data.page, pageSize: data.pageSize, pageCount: data.pageCount });
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载用户列表失败");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [q, status, plan, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters() {
    if (page !== 1) setPage(1);
    else void load();
  }

  function refreshFromFirstPage() {
    if (page !== 1) setPage(1);
    else void load();
  }

  async function quickToggleStatus(user: AdminUserRow) {
    setBusyId(user.id);
    setError("");
    try {
      const next: Status = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "操作失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId("");
    }
  }

  async function deleteUser(user: AdminUserRow) {
    const message = `确定删除「${displayName(user)}」吗？\n这会一并删除该用户的所有项目，且不可恢复。\n日常建议改用「停用」。`;
    if (!window.confirm(message)) return;
    setBusyId(user.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "删除失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusyId("");
    }
  }

  return (
    <AdminShell>
      <div className="admin-users-shell mx-auto">
        <div className="admin-users-header rounded-2xl p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-cyan-200/70">User Management</div>
              <h1 className="text-3xl font-black text-white">用户管理</h1>
              <p className="mt-2 text-sm text-slate-400">共 {meta.total} 位用户。可搜索、手动新增、改套餐 / 额度、停用 / 启用、删除。</p>
            </div>
            <button onClick={() => setCreating(true)} className="projects-action-button projects-action-primary">
              <UserPlus className="h-4 w-4" />
              新增用户
            </button>
          </div>
        </div>

      <div className="admin-users-filterbar mt-5 flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/60" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            placeholder="搜索邮箱 / 手机号"
            className="control-input w-64 rounded-xl py-2.5 pl-9 pr-3 text-sm"
          />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as "" | Status)} className="control-input rounded-xl px-3 py-2.5 text-sm">
          <option value="">全部状态</option>
          <option value="ACTIVE">正常</option>
          <option value="DISABLED">停用</option>
        </select>
        <select value={plan} onChange={(e) => setPlan(e.target.value as "" | Plan)} className="control-input rounded-xl px-3 py-2.5 text-sm">
          <option value="">全部套餐</option>
          <option value="FREE">FREE</option>
          <option value="PRO">PRO</option>
        </select>
        <button onClick={applyFilters} className="primary-neon rounded-xl px-5 py-2.5 text-sm font-bold">
          查询
        </button>
      </div>

      {error && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{error}</p>}

      <div className="admin-users-table-shell mt-5 overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
          <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
            <tr>
              <th className="p-3">账号</th>
              <th className="p-3">角色</th>
              <th className="p-3">套餐</th>
              <th className="p-3">状态</th>
              <th className="p-3">积分</th>
              <th className="p-3">每日上限</th>
              <th className="p-3">项目数</th>
              <th className="p-3">最后登录</th>
              <th className="p-3">登录次数</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="p-8 text-center text-slate-400">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-8 text-center text-slate-500">
                  没有匹配的用户
                </td>
              </tr>
            ) : (
              rows.map((user) => (
                <tr key={user.id} className="admin-table-row">
                  <td className="p-3 font-semibold text-white">{displayName(user)}</td>
                  <td className="p-3">{user.role}</td>
                  <td className="p-3">{user.plan}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${user.status === "ACTIVE" ? "bg-emerald-400/15 text-emerald-200" : "bg-red-400/15 text-red-200"}`}>
                      {user.status === "ACTIVE" ? "正常" : "停用"}
                    </span>
                  </td>
                  <td className="p-3">{user.credits}</td>
                  <td className="p-3">{user.dailyLimit}</td>
                  <td className="p-3">{user.projectCount}</td>
                  <td className="p-3 text-slate-400">{formatDate(user.lastLoginAt)}</td>
                  <td className="p-3 text-slate-400">{user.loginCount}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setEditing(user)} className="admin-mini-button border-cyan-300/18 bg-cyan-300/10 text-cyan-50 hover:bg-cyan-300/16">
                        编辑
                      </button>
                      <button onClick={() => quickToggleStatus(user)} disabled={busyId === user.id} className="admin-mini-button disabled:opacity-60">
                        <Power className="h-3.5 w-3.5" />
                        {user.status === "ACTIVE" ? "停用" : "启用"}
                      </button>
                      <button onClick={() => deleteUser(user)} disabled={busyId === user.id} className="admin-mini-button border-red-300/20 bg-red-500/10 text-red-50 hover:bg-red-500/16 disabled:opacity-60">
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
        <span>
          第 {meta.page} / {meta.pageCount} 页
        </span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={meta.page <= 1} className="muted-button rounded-lg px-4 py-2 font-semibold disabled:opacity-40">
            上一页
          </button>
          <button onClick={() => setPage((p) => Math.min(meta.pageCount, p + 1))} disabled={meta.page >= meta.pageCount} className="muted-button rounded-lg px-4 py-2 font-semibold disabled:opacity-40">
            下一页
          </button>
        </div>
      </div>

      {creating && <CreateUserModal onClose={() => setCreating(false)} onSaved={refreshFromFirstPage} />}
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={load} />}
      </div>
    </AdminShell>
  );
}
