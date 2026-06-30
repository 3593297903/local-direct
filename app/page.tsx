import type { CSSProperties } from "react";
import { ArrowRight, FolderOpen, Sparkles, Video } from "lucide-react";
import { UserAccountNav } from "@/components/UserAccountNav";

const homeParticles = Array.from({ length: 34 }, (_, index) => ({
  left: `${(index * 41 + 9) % 100}%`,
  top: `${(index * 59 + 13) % 100}%`,
  size: `${4 + ((index * 5) % 13)}px`,
  delay: `${-((index * 0.43) % 8)}s`,
  duration: `${16 + ((index * 7) % 18)}s`,
  color: [
    "rgba(129, 140, 248, 0.44)",
    "rgba(167, 139, 250, 0.44)",
    "rgba(14, 165, 233, 0.42)",
    "rgba(244, 114, 182, 0.34)",
  ][index % 4],
}));

export default function HomePage() {
  return (
    <main className="workspace-hero-shell relative min-h-screen overflow-hidden text-slate-100">
      <div className="workspace-orb-field absolute inset-0">
        {homeParticles.map((particle, index) => (
          <span
            key={index}
            className="workspace-particle"
            style={{
              "--particle-left": particle.left,
              "--particle-top": particle.top,
              "--particle-size": particle.size,
              "--particle-delay": particle.delay,
              "--particle-duration": particle.duration,
              "--particle-color": particle.color,
            } as CSSProperties}
          />
        ))}
      </div>

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <a href="/" className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-200 shadow-neon">
            <Video className="h-5 w-5" />
          </span>
          <span>
            <span className="block font-semibold text-white">AI Video Director</span>
            <span className="block text-xs text-cyan-100/55">Local AI Video Director</span>
          </span>
        </a>
        <div className="flex items-center gap-3">
          <UserAccountNav />
          <a href="/dashboard" className="primary-neon inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold">
            进入工作台 <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </header>

      <section className="relative z-10 mx-auto flex min-h-[calc(100vh-84px)] max-w-5xl flex-col items-center justify-center px-5 pb-14 pt-8 text-center">
        <div className="mb-5 flex items-center justify-center gap-3">
          <span className="title-planet" aria-hidden="true">
            <span className="title-planet-ring" />
            <span className="title-planet-core" />
            <span className="title-star title-star-one" />
            <span className="title-star title-star-two" />
            <span className="title-star title-star-three" />
          </span>
          <h1 className="bg-gradient-to-r from-violet-200 via-fuchsia-300 to-cyan-200 bg-clip-text text-4xl font-black text-transparent md:text-6xl">
            超创视频工作站
          </h1>
        </div>

        <p className="max-w-2xl text-sm leading-7 text-slate-400 md:text-base">
          输入文案后自动拆解节奏、镜头、声音和完整视频提示词，并把每次生成保存到我的项目，方便在不同电脑上继续创作。
        </p>

        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <a href="/dashboard" className="primary-neon inline-flex items-center gap-2 rounded-xl px-6 py-3 font-semibold">
            开始生成 <Sparkles className="h-4 w-4" />
          </a>
          <a href="/projects" className="muted-button inline-flex items-center gap-2 rounded-xl px-6 py-3 font-semibold">
            查看我的项目 <FolderOpen className="h-4 w-4" />
          </a>
        </div>
      </section>
    </main>
  );
}
