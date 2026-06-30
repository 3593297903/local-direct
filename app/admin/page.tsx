"use client";

import { BarChart3, ClipboardList, FolderOpen, Layers, ShieldCheck, Users } from "lucide-react";
import { AdminShell } from "@/components/AdminShell";

const modules = [
  {
    title: "用户管理",
    href: "/admin/users",
    description: "新增用户、修改套餐和额度、停用或删除账号。",
    icon: Users,
  },
  {
    title: "项目管理",
    href: "/admin/projects",
    description: "查看用户项目、剧集、提示词、分镜和生成记录。",
    icon: FolderOpen,
  },
  {
    title: "用量额度",
    href: "/admin/usage",
    description: "查看今日生成、累计调用、积分池和每日额度。",
    icon: BarChart3,
  },
  {
    title: "生成日志",
    href: "/admin/logs",
    description: "排查生成成功、失败、模型、错误原因和耗时。",
    icon: ClipboardList,
  },
  {
    title: "素材库",
    href: "/admin/library",
    description: "管理转场、景别、运镜和风格素材。",
    icon: Layers,
  },
];

export default function AdminHomePage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <section className="rounded-2xl border border-white/15 bg-slate-950/60 p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10">
              <ShieldCheck className="h-5 w-5 text-cyan-200" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Admin Console</p>
              <h1 className="mt-1 text-4xl font-black text-white">运营后台</h1>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-400">
            这里用于管理 AI Video Director 的用户、项目、额度、生成日志和素材库。管理员身份已通过本地
            env 管理员会话或数据库 ADMIN 角色校验。
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {modules.map((item) => {
            const Icon = item.icon;
            return (
              <a
                key={item.href}
                href={item.href}
                className="rounded-2xl border border-white/10 bg-slate-950/60 p-5 transition hover:border-cyan-200/50 hover:bg-cyan-300/[0.04]"
              >
                <span className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10">
                  <Icon className="h-5 w-5 text-cyan-100" />
                </span>
                <h2 className="mt-5 text-lg font-black text-white">{item.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">{item.description}</p>
              </a>
            );
          })}
        </section>
      </div>
    </AdminShell>
  );
}
