"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Copy, Edit3, LogOut, PlusCircle, Save, Search, Trash2, UploadCloud, X } from "lucide-react";
import { Drawer } from "@/components/Drawer";
import { LibraryCard } from "@/components/LibraryCard";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { GENRE_OPTIONS } from "@/lib/genre-options";
import { createKnowledgeItemCopyDraft } from "@/lib/knowledge-copy";
import { KnowledgeItem, KnowledgeType } from "@/types";

const typeLabels: Record<string, string> = {
  transition: "转场",
  shot: "景别",
  camera_movement: "运镜",
  style: "风格",
  storyboard_formula: "分镜公式库",
};

const typeOptions: Array<{ value: KnowledgeType; label: string }> = [
  { value: "transition", label: "转场" },
  { value: "shot", label: "镜头" },
  { value: "camera_movement", label: "运镜" },
  { value: "style", label: "风格" },
  { value: "storyboard_formula", label: "分镜公式" },
];

type AdminMode = "idle" | "edit" | "copy" | "delete";
type EditIntent = "create" | "edit" | "copy";

const blankItem: KnowledgeItem = {
  id: "",
  type: "transition",
  category: "自定义转场",
  name: "",
  description: "",
  prompt: "",
  tags: [],
  genre: "剧情",
  stability: 90,
  order: undefined,
  useCase: "",
  avoid: "",
  previewType: "camera",
};

function blankForType(type?: KnowledgeType): KnowledgeItem {
  const itemType = type || "transition";
  const category =
    itemType === "transition"
      ? "自定义转场"
      : itemType === "shot"
        ? "自定义镜头"
        : itemType === "camera_movement"
          ? "自定义运镜"
          : itemType === "style"
            ? "自定义风格"
            : "自定义分镜公式";
  return { ...blankItem, type: itemType, category };
}

function tagsToText(tags: string[]) {
  return tags.join(", ");
}

function parseTags(value: string) {
  return value
    .split(/[,\n，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function readJsonResponse(res: Response) {
  const text = await res.text();
  if (!text) throw new Error(`接口没有返回内容（HTTP ${res.status}）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }
}

function filterByType(items: KnowledgeItem[], type?: KnowledgeType) {
  return type ? items.filter((item) => item.type === type) : items;
}

function EditModal({
  item,
  type,
  intent,
  onClose,
  onSaved,
}: {
  item: KnowledgeItem;
  type?: KnowledgeType;
  intent: EditIntent;
  onClose: () => void;
  onSaved: (items: KnowledgeItem[], item: KnowledgeItem) => void;
}) {
  const [draft, setDraft] = useState<KnowledgeItem>(item);
  const [tagText, setTagText] = useState(tagsToText(item.tags));
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const preview = useMemo(() => ({ ...draft, tags: parseTags(tagText) }), [draft, tagText]);
  const modalTitle = intent === "copy" ? "复制素材" : intent === "create" ? "新增素材" : "编辑素材";
  const modalEyebrow = intent === "copy" ? "Copy Material" : intent === "create" ? "Upload Material" : "Edit Material";

  function updateField<K extends keyof KnowledgeItem>(key: K, value: KnowledgeItem[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    const formData = new FormData();
    formData.set("id", draft.id);
    formData.set("type", draft.type);
    formData.set("category", draft.category);
    formData.set("name", draft.name);
    formData.set("description", draft.description);
    formData.set("prompt", draft.prompt);
    formData.set("tags", tagText);
    formData.set("genre", draft.genre || "");
    formData.set("stability", String(draft.stability || 90));
    formData.set("order", String(draft.order || ""));
    formData.set("useCase", draft.useCase);
    formData.set("avoid", draft.avoid || "");
    formData.set("previewUrl", draft.previewUrl || "");
    formData.set("previewMimeType", draft.previewMimeType || "");
    formData.set("posterUrl", draft.posterUrl || "");
    if (file) formData.set("previewFile", file);

    try {
      const res = await fetch("/api/admin/library", { method: "POST", body: formData });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
      onSaved(data.items || [], data.item);
      onClose();
    } catch (error: any) {
      setMessage(error.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={onSubmit}
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-cyan-300/20 bg-slate-950 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase text-cyan-200/70">{modalEyebrow}</p>
            <h2 className="mt-1 text-2xl font-black text-white">{modalTitle}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 p-2 text-slate-300 transition hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <PreviewAnimation item={preview} type={preview.previewType} />
            <label className="mt-4 block rounded-xl border border-dashed border-cyan-300/24 bg-cyan-300/[0.04] p-4">
              <span className="flex items-center gap-2 text-sm font-semibold text-white">
                <UploadCloud className="h-4 w-4 text-cyan-200" /> 上传预览素材
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
                className="mt-3 block w-full text-sm text-slate-300"
              />
              {file && <p className="mt-2 text-xs text-cyan-100">{file.name}</p>}
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">类型</span>
              <select
                value={draft.type}
                onChange={(event) => updateField("type", event.target.value as KnowledgeType)}
                className="control-input w-full rounded-xl px-3 py-3 text-sm"
              >
                {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">排序</span>
              <input
                type="number"
                min="1"
                value={draft.order || ""}
                onChange={(event) => updateField("order", event.target.value ? Number(event.target.value) : undefined)}
                className="control-input w-full rounded-xl px-3 py-3 text-sm"
                placeholder="留空自动排到最后"
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">分类</span>
              <input value={draft.category} onChange={(event) => updateField("category", event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">片种类别</span>
              <select
                value={draft.genre || "剧情"}
                onChange={(event) => updateField("genre", event.target.value)}
                className="control-input w-full rounded-xl px-3 py-3 text-sm"
              >
                {GENRE_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">名称</span>
              <input value={draft.name} onChange={(event) => updateField("name", event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">描述</span>
              <textarea value={draft.description} onChange={(event) => updateField("description", event.target.value)} className="control-input h-24 w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">标签，用逗号分隔</span>
              <input value={tagText} onChange={(event) => setTagText(event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">适合场景</span>
              <textarea value={draft.useCase} onChange={(event) => updateField("useCase", event.target.value)} className="control-input h-20 w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">不适合场景</span>
              <textarea value={draft.avoid || ""} onChange={(event) => updateField("avoid", event.target.value)} className="control-input h-20 w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">完整提示词</span>
              <textarea value={draft.prompt} onChange={(event) => updateField("prompt", event.target.value)} className="control-input h-32 w-full rounded-xl px-3 py-3 text-sm" />
            </label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          {message && <p className="mr-auto rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">{message}</p>}
          <button type="button" onClick={onClose} className="muted-button rounded-xl px-5 py-3 font-bold">取消</button>
          <button type="submit" disabled={saving} className="primary-neon inline-flex items-center gap-2 rounded-xl px-5 py-3 font-bold disabled:opacity-60">
            <Save className="h-4 w-4" /> {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function LibraryClient({ initialItems, type }: { initialItems: KnowledgeItem[]; type?: KnowledgeType }) {
  const [items, setItems] = useState(initialItems);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [mode, setMode] = useState<AdminMode>("idle");
  const [editingItem, setEditingItem] = useState<KnowledgeItem | null>(null);
  const [editingIntent, setEditingIntent] = useState<EditIntent>("edit");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch("/api/admin/session")
      .then((res) => res.json())
      .then((data) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false));
  }, []);

  const categories = useMemo(() => ["全部", ...Array.from(new Set(items.map((item) => item.category)))], [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const categoryMatch = category === "全部" || item.category === category;
      const text = [item.name, item.description, item.category, item.genre || "", item.tags.join(" "), item.prompt].join(" ").toLowerCase();
      return categoryMatch && (!q || text.includes(q));
    });
  }, [query, category, items]);

  function applyItems(nextItems: KnowledgeItem[]) {
    setItems(filterByType(nextItems, type));
    setCheckedIds([]);
    setMessage("");
  }

  function openAdd() {
    setMode("idle");
    setEditingIntent("create");
    setEditingItem(blankForType(type));
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    setAuthenticated(false);
    setAdminOpen(false);
    setMode("idle");
    setCheckedIds([]);
  }

  async function deleteChecked() {
    if (mode !== "delete") {
      setMode("delete");
      setCheckedIds([]);
      return;
    }
    if (!checkedIds.length) {
      setMessage("请先勾选要删除的素材");
      return;
    }
    if (!window.confirm(`确定彻底删除 ${checkedIds.length} 个素材吗？`)) return;
    setDeleting(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/library?ids=${encodeURIComponent(checkedIds.join(","))}`, { method: "DELETE" });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "删除失败");
      applyItems(data.items || []);
      setMode("idle");
    } catch (error: any) {
      setMessage(error.message || "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  function onCardClick(item: KnowledgeItem) {
    if (mode === "edit") {
      setEditingIntent("edit");
      setEditingItem(item);
      return;
    }
    if (mode === "copy") {
      setEditingIntent("copy");
      setEditingItem(createKnowledgeItemCopyDraft(item, items));
      setMode("idle");
      setMessage("");
      return;
    }
    if (mode === "delete") {
      setCheckedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
      return;
    }
    setSelected(item);
  }

  return (
    <section className="mx-auto max-w-[112rem]">
      <div className="library-hero-panel mb-5 rounded-[1.35rem] p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div>
            <p className="text-xs uppercase text-cyan-200/70">Knowledge Library</p>
            <h1 className="mt-1 text-4xl font-black text-white">{typeLabels[type || ""] || "知识库"}</h1>
            <p className="mt-2 text-sm text-slate-400">点击封面打开右侧抽屉，查看描述、提示词和适用场景。</p>
          </div>
          <div className="relative w-full max-w-md">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-200/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索：悬疑、黑场、回忆、遮挡..."
              className="control-input w-full rounded-xl py-3 pl-11 pr-4 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="library-toolbar sticky top-4 z-30 mb-6 rounded-[1.15rem] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`library-filter-chip ${
                  category === c
                    ? "library-filter-chip-active"
                    : ""
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {message && <span className="rounded-lg border border-cyan-300/16 bg-cyan-300/8 px-3 py-2 text-xs text-cyan-100">{message}</span>}
            {authenticated && (
              <>
                <button
                  onClick={() => {
                    setAdminOpen((open) => !open);
                    setMode("idle");
                    setCheckedIds([]);
                  }}
                  className="primary-neon inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold"
                >
                  <Edit3 className="h-4 w-4" /> 编辑
                </button>
                {adminOpen && (
                  <>
                    <button onClick={openAdd} className="muted-button inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold">
                      <PlusCircle className="h-4 w-4" /> 新增
                    </button>
                    <button
                      onClick={() => {
                        setMode((current) => current === "edit" ? "idle" : "edit");
                        setCheckedIds([]);
                      }}
                      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold ${
                        mode === "edit" ? "border border-cyan-300/30 bg-cyan-300/12 text-cyan-100" : "muted-button"
                      }`}
                    >
                      <Edit3 className="h-4 w-4" /> 编辑素材
                    </button>
                    <button
                      onClick={() => {
                        setMode((current) => current === "copy" ? "idle" : "copy");
                        setCheckedIds([]);
                      }}
                      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold ${
                        mode === "copy" ? "border border-violet-300/35 bg-violet-400/15 text-violet-100" : "muted-button"
                      }`}
                    >
                      <Copy className="h-4 w-4" /> 复制
                    </button>
                    <button
                      onClick={deleteChecked}
                      disabled={deleting}
                      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold ${
                        mode === "delete" ? "border border-red-400/35 bg-red-500/15 text-red-100" : "muted-button"
                      }`}
                    >
                      <Trash2 className="h-4 w-4" />
                      {mode === "delete" && checkedIds.length ? `删除 ${checkedIds.length}` : deleting ? "删除中..." : "删除"}
                    </button>
                  </>
                )}
                <button onClick={logout} className="muted-button inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold">
                  <LogOut className="h-4 w-4" /> 退出
                </button>
              </>
            )}
          </div>
        </div>
        {mode === "edit" && <p className="mt-2 text-xs text-cyan-100/75">编辑模式：点击任意素材进行修改。</p>}
        {mode === "copy" && <p className="mt-2 text-xs text-violet-100/75">复制模式：点击任意素材，会打开一个新的复制草稿，修改后保存为新素材。</p>}
        {mode === "delete" && <p className="mt-2 text-xs text-red-100/75">删除模式：勾选素材右上角的框，再点击顶部删除。</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {filtered.map((item) => (
          <LibraryCard
            key={item.id}
            item={item}
            onOpen={onCardClick}
            selectable={mode === "delete"}
            selected={checkedIds.includes(item.id)}
          />
        ))}
      </div>

      <Drawer item={selected} onClose={() => setSelected(null)} />
      {editingItem && (
        <EditModal
          item={editingItem}
          type={type}
          intent={editingIntent}
          onClose={() => setEditingItem(null)}
          onSaved={(nextItems) => applyItems(nextItems)}
        />
      )}
    </section>
  );
}
