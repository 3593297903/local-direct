"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Star, Tag, X } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { formatDisplayTag } from "@/lib/library-tags";
import { KnowledgeItem } from "@/types";

export function Drawer({ item, onClose }: { item: KnowledgeItem | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {item && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.aside
            className="h-full w-full max-w-xl overflow-y-auto border-l border-cyan-300/16 bg-slate-950 p-6 shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="mb-1 text-sm text-cyan-200/60">{item.category}</div>
                <h2 className="text-3xl font-bold text-white">{item.name}</h2>
              </div>
              <button className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-slate-300 hover:border-cyan-300/25 hover:text-white" onClick={onClose}>
                <X className="h-5 w-5" />
              </button>
            </div>

            <PreviewAnimation item={item} type={item.previewType} />
            <div className="mt-5 flex flex-wrap gap-2">
              {item.tags.map((tag) => (
                <span key={tag} className="rounded-lg border border-white/8 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300">{formatDisplayTag(tag)}</span>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-cyan-300/14 bg-cyan-300/[0.04] p-5">
              <div className="mb-3 text-sm font-bold text-white">描述</div>
              <p className="text-sm leading-7 text-slate-300">{item.description}</p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="section-shell rounded-2xl p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white"><Tag className="h-4 w-4 text-cyan-200" /> 适合场景</div>
                <p className="text-sm leading-6 text-slate-400">{item.useCase}</p>
              </div>
              <div className="section-shell rounded-2xl p-4">
                <div className="mb-2 text-sm font-semibold text-white">不适合场景</div>
                <p className="text-sm leading-6 text-slate-400">{item.avoid || "暂无"}</p>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-cyan-300/14 bg-cyan-300/[0.04] p-5">
              <div className="mb-3 text-sm font-bold text-white">完整中文提示词</div>
              <p className="text-sm leading-7 text-slate-300">{item.prompt}</p>
              <div className="mt-5 flex gap-3">
                <CopyButton text={item.prompt} label="复制提示词" />
                <button className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-slate-300 hover:border-cyan-300/25 hover:text-white">
                  <Star className="h-4 w-4" /> 收藏
                </button>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-cyan-300/16 bg-slate-900/70 p-5">
              <div className="mb-3 text-sm font-bold text-white">推荐搭配</div>
              <ul className="space-y-2 text-sm leading-6 text-slate-400">
                <li>• 前一镜头：中景或特写，人物动作清晰。</li>
                <li>• 转场节点：用遮挡、强光或动作完成切换。</li>
                <li>• 后一镜头：保持相同方向、相近色调和情绪延续。</li>
              </ul>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
