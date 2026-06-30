"use client";

import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Search, Trash2 } from "lucide-react";
import { AdminShell } from "@/components/AdminShell";

type AdminProject = {
  id: string;
  title: string;
  contentType?: string | null;
  style?: string | null;
  duration?: string | null;
  status: string;
  user?: { email?: string | null; phone?: string | null };
  versionCount: number;
  shotCount: number;
  jobCount: number;
  updatedAt: string;
};

type ProjectDetail = AdminProject & {
  originalScript?: string;
  optimizedScript?: string | null;
  versions?: Array<{
    id: string;
    versionNumber: number;
    title: string;
    fullVideoPrompt?: string | null;
    shots?: unknown[];
    createdAt: string;
  }>;
  jobs?: Array<{ id: string; type: string; status: string; error?: string | null; createdAt: string }>;
};

export default function AdminProjectsPage() {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadProjects() {
    setLoading(true);
    setError("");
    const search = new URLSearchParams();
    if (q.trim()) search.set("q", q.trim());
    const response = await fetch(`/api/admin/projects?${search.toString()}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    setLoading(false);
    if (!response.ok || !data?.ok) {
      setError(data?.error || "项目列表加载失败");
      return;
    }
    const rows = data.data?.projects || [];
    setProjects(rows);
    if (!selected && rows[0]) void loadDetail(rows[0].id);
  }

  async function loadDetail(id: string) {
    setError("");
    const response = await fetch(`/api/admin/projects/${id}`, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      setError(data?.error || "项目详情加载失败");
      return;
    }
    setSelected(data.data.project);
  }

  async function deleteProject(id: string) {
    if (!confirm("确定删除这个项目吗？该项目的剧集和镜头表会一起删除。")) return;
    const response = await fetch(`/api/admin/projects/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      setError(data?.error || "项目删除失败");
      return;
    }
    setSelected(null);
    await loadProjects();
  }

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latestVersion = useMemo(() => selected?.versions?.[0], [selected]);

  return (
    <AdminShell>
      <div className="space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Project Management</p>
          <h1 className="mt-2 text-4xl font-black text-white">项目管理</h1>
          <p className="mt-2 text-sm text-slate-400">查看所有用户项目、剧集、提示词和生成记录，必要时删除违规项目。</p>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex h-11 w-80 items-center gap-2 rounded-xl border border-cyan-300/20 bg-slate-950 px-3 text-sm text-slate-300">
            <Search className="h-4 w-4 text-cyan-200" />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none"
              placeholder="搜索标题 / 用户 / 文案"
            />
          </label>
          <button
            type="button"
            onClick={loadProjects}
            className="h-11 rounded-xl bg-gradient-to-r from-cyan-300 to-blue-600 px-5 text-sm font-black text-slate-950"
          >
            查询
          </button>
        </div>

        {error ? <div className="rounded-xl border border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">{error}</div> : null}

        <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
          <section className="rounded-2xl border border-white/15 bg-slate-950/60 p-4">
            <h2 className="mb-3 text-base font-black text-white">项目列表</h2>
            <div className="space-y-2">
              {loading ? <p className="text-sm text-slate-500">加载中...</p> : null}
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => loadDetail(project.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selected?.id === project.id
                      ? "border-cyan-200 bg-cyan-300/10"
                      : "border-white/10 bg-slate-900/60 hover:border-cyan-200/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-black text-white">{project.title}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {project.user?.email || project.user?.phone || "未知用户"} · {project.duration || "-"}
                      </p>
                    </div>
                    <span className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-slate-400">
                      {project.versionCount} 集
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-white/15 bg-slate-950/60 p-5">
            {selected ? (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Project Detail</p>
                    <h2 className="mt-2 text-2xl font-black text-white">{selected.title}</h2>
                    <p className="mt-1 text-sm text-slate-400">
                      {selected.contentType || "-"} · {selected.style || "-"} · {selected.duration || "-"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteProject(selected.id)}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-300/30 bg-red-950/30 px-4 py-2 text-sm font-bold text-red-100"
                  >
                    <Trash2 className="h-4 w-4" />
                    删除项目
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <Stat label="镜头数" value={selected.shotCount} />
                  <Stat label="剧集数" value={selected.versionCount} />
                  <Stat label="生成记录" value={selected.jobCount} />
                </div>

                <Panel title="原文">
                  <p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">{selected.originalScript || "暂无原文"}</p>
                </Panel>

                <Panel title="最新完整提示词">
                  <p className="max-h-80 overflow-auto whitespace-pre-wrap text-sm leading-7 text-slate-300">
                    {latestVersion?.fullVideoPrompt || "暂无完整视频提示词"}
                  </p>
                </Panel>

                <Panel title="生成记录">
                  <div className="space-y-2">
                    {(selected.jobs || []).map((job) => (
                      <div key={job.id} className="rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 text-sm text-slate-300">
                        {job.type} · {job.status} · {new Date(job.createdAt).toLocaleString()}
                        {job.error ? <p className="mt-1 text-red-200">{job.error}</p> : null}
                      </div>
                    ))}
                    {!selected.jobs?.length ? <p className="text-sm text-slate-500">暂无生成记录</p> : null}
                  </div>
                </Panel>
              </div>
            ) : (
              <div className="grid min-h-80 place-items-center text-slate-500">
                <div className="text-center">
                  <FolderOpen className="mx-auto h-8 w-8" />
                  <p className="mt-2 text-sm">选择一个项目查看详情</p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-black text-white">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
      <h3 className="mb-3 text-sm font-black text-white">{title}</h3>
      {children}
    </div>
  );
}
