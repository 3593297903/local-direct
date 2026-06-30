"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AdminShell } from "@/components/AdminShell";

type UsageSummary = {
  userCount: number;
  activeUserCount: number;
  projectCount: number;
  analyzeToday: number;
  analyzeTotal: number;
  completedJobsToday: number;
  failedJobsToday: number;
  totalCredits: number;
  totalDailyLimit: number;
};

type UsageEvent = {
  id: string;
  eventType: string;
  provider?: string | null;
  model?: string | null;
  inputChars: number;
  outputChars: number;
  createdAt: string;
  user?: { email?: string | null; phone?: string | null };
};

export default function AdminUsagePage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    const [summaryResponse, eventsResponse] = await Promise.all([
      fetch("/api/admin/usage/summary", { cache: "no-store" }),
      fetch(`/api/admin/usage/events?${params.toString()}`, { cache: "no-store" }),
    ]);
    const summaryData = await summaryResponse.json().catch(() => null);
    const eventsData = await eventsResponse.json().catch(() => null);
    if (!summaryResponse.ok || !summaryData?.ok) {
      setError(summaryData?.error || "用量概览加载失败");
      return;
    }
    if (!eventsResponse.ok || !eventsData?.ok) {
      setError(eventsData?.error || "用量记录加载失败");
      return;
    }
    setSummary(summaryData.data);
    setEvents(eventsData.data?.events || []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AdminShell>
      <div className="space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Usage & Quota</p>
          <h1 className="mt-2 text-4xl font-black text-white">用量额度</h1>
          <p className="mt-2 text-sm text-slate-400">查看生成次数、用户额度、今日成功和失败情况。用户积分和每日上限在用户管理里编辑。</p>
        </header>

        {error ? <div className="rounded-xl border border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">{error}</div> : null}

        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="用户总数" value={summary?.userCount ?? 0} />
          <Stat label="今日生成" value={summary?.analyzeToday ?? 0} />
          <Stat label="累计生成" value={summary?.analyzeTotal ?? 0} />
          <Stat label="今日失败" value={summary?.failedJobsToday ?? 0} />
          <Stat label="项目总数" value={summary?.projectCount ?? 0} />
          <Stat label="活跃用户" value={summary?.activeUserCount ?? 0} />
          <Stat label="剩余积分池" value={summary?.totalCredits ?? 0} />
          <Stat label="每日额度池" value={summary?.totalDailyLimit ?? 0} />
        </div>

        <section className="rounded-2xl border border-white/15 bg-slate-950/60 p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex h-11 w-80 items-center gap-2 rounded-xl border border-cyan-300/20 bg-slate-950 px-3 text-sm text-slate-300">
              <Search className="h-4 w-4 text-cyan-200" />
              <input
                value={q}
                onChange={(event) => setQ(event.target.value)}
                className="min-w-0 flex-1 bg-transparent outline-none"
                placeholder="搜索用户 / 模型 / provider"
              />
            </label>
            <button type="button" onClick={load} className="h-11 rounded-xl bg-gradient-to-r from-cyan-300 to-blue-600 px-5 text-sm font-black text-slate-950">
              查询
            </button>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="text-cyan-100">
                <tr className="border-b border-cyan-300/20">
                  <th className="p-3">用户</th>
                  <th className="p-3">事件</th>
                  <th className="p-3">Provider</th>
                  <th className="p-3">模型</th>
                  <th className="p-3">输入字符</th>
                  <th className="p-3">输出字符</th>
                  <th className="p-3">时间</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-b border-white/10 text-slate-300">
                    <td className="p-3">{event.user?.email || event.user?.phone || "-"}</td>
                    <td className="p-3">{event.eventType}</td>
                    <td className="p-3">{event.provider || "-"}</td>
                    <td className="p-3">{event.model || "-"}</td>
                    <td className="p-3">{event.inputChars}</td>
                    <td className="p-3">{event.outputChars}</td>
                    <td className="p-3">{new Date(event.createdAt).toLocaleString()}</td>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-white">{value}</p>
    </div>
  );
}
