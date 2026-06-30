"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AdminShell } from "@/components/AdminShell";

type JobLog = {
  id: string;
  type: string;
  status: string;
  error?: string | null;
  attempts: number;
  createdAt: string;
  completedAt?: string | null;
  user?: { email?: string | null; phone?: string | null };
  project?: { id: string; title: string } | null;
  output?: Record<string, unknown> | null;
};

export default function AdminLogsPage() {
  const [jobs, setJobs] = useState<JobLog[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    const response = await fetch(`/api/admin/logs?${params.toString()}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      setError(data?.error || "生成日志加载失败");
      return;
    }
    setJobs(data.data?.jobs || []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AdminShell>
      <div className="space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Generation Logs</p>
          <h1 className="mt-2 text-4xl font-black text-white">生成日志</h1>
          <p className="mt-2 text-sm text-slate-400">查看每次生成请求的成功失败、所属用户、项目、耗时和错误原因。</p>
        </header>

        {error ? <div className="rounded-xl border border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">{error}</div> : null}

        <section className="rounded-2xl border border-white/15 bg-slate-950/60 p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex h-11 w-80 items-center gap-2 rounded-xl border border-cyan-300/20 bg-slate-950 px-3 text-sm text-slate-300">
              <Search className="h-4 w-4 text-cyan-200" />
              <input
                value={q}
                onChange={(event) => setQ(event.target.value)}
                className="min-w-0 flex-1 bg-transparent outline-none"
                placeholder="搜索用户 / 项目 / 错误"
              />
            </label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none"
            >
              <option value="">全部状态</option>
              <option value="COMPLETED">成功</option>
              <option value="FAILED">失败</option>
              <option value="PENDING">等待</option>
              <option value="RUNNING">运行中</option>
            </select>
            <button type="button" onClick={load} className="h-11 rounded-xl bg-gradient-to-r from-cyan-300 to-blue-600 px-5 text-sm font-black text-slate-950">
              查询
            </button>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="text-cyan-100">
                <tr className="border-b border-cyan-300/20">
                  <th className="p-3">用户</th>
                  <th className="p-3">项目</th>
                  <th className="p-3">类型</th>
                  <th className="p-3">状态</th>
                  <th className="p-3">镜头数</th>
                  <th className="p-3">错误</th>
                  <th className="p-3">时间</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-white/10 text-slate-300">
                    <td className="p-3">{job.user?.email || job.user?.phone || "-"}</td>
                    <td className="p-3">{job.project?.title || "-"}</td>
                    <td className="p-3">{job.type}</td>
                    <td className="p-3">{job.status}</td>
                    <td className="p-3">{String(job.output?.storyboardCount ?? "-")}</td>
                    <td className="max-w-md p-3 text-red-100">{job.error || "-"}</td>
                    <td className="p-3">{new Date(job.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
