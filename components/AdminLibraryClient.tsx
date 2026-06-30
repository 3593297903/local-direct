"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Copy, PlusCircle, Save, Trash2, UploadCloud } from "lucide-react";
import type { KnowledgeItem, KnowledgeType } from "@/types";
import { PreviewAnimation } from "@/components/PreviewAnimation";
import { GENRE_OPTIONS } from "@/lib/genre-options";

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

const MAX_PREVIEW_UPLOAD_BYTES = 25 * 1024 * 1024;

const typeOptions: Array<{ value: KnowledgeType; label: string }> = [
  { value: "transition", label: "转场" },
  { value: "shot", label: "镜头" },
  { value: "camera_movement", label: "运镜" },
  { value: "style", label: "风格" },
  { value: "storyboard_formula", label: "分镜公式" },
];

function tagsToText(tags: string[]) {
  return tags.join(", ");
}

function bytesToMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function makeBlankItem(type: KnowledgeType = "transition"): KnowledgeItem {
  return {
    ...blankItem,
    type,
    category: type === "transition" ? "自定义转场" : type === "shot" ? "自定义镜头" : type === "camera_movement" ? "自定义运镜" : "自定义风格",
  };
}

async function readJsonResponse(res: Response) {
  const text = await res.text();
  if (!text) {
    throw new Error(`接口没有返回内容（HTTP ${res.status}），请查看服务端日志或稍后重试。`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 180)}`);
  }
}

export function AdminLibraryClient({
  initialItems,
  initialSelectedId = "",
  initialType = "transition",
  embedded = false,
  onItemsChanged,
  onClose,
}: {
  initialItems: KnowledgeItem[];
  initialSelectedId?: string;
  initialType?: KnowledgeType;
  embedded?: boolean;
  onItemsChanged?: (items: KnowledgeItem[]) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<KnowledgeItem>(makeBlankItem(initialType));
  const [tagText, setTagText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [authenticated, setAuthenticated] = useState(embedded);
  const [authChecked, setAuthChecked] = useState(embedded);
  const [loginMessage, setLoginMessage] = useState("");

  const selectedPreview = useMemo(() => ({ ...draft, tags: tagText.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean) }), [draft, tagText]);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    if (embedded) return;
    fetch("/api/admin/session")
      .then((res) => res.json())
      .then((data) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true));
  }, [embedded]);

  useEffect(() => {
    if (!initialSelectedId) {
      setSelectedId("");
      setDraft(makeBlankItem(initialType));
      setTagText("");
      setFile(null);
      return;
    }
    const item = initialItems.find((entry) => entry.id === initialSelectedId);
    if (!item) return;
    setSelectedId(item.id);
    setDraft(item);
    setTagText(tagsToText(item.tags));
    setFile(null);
    setMessage("");
  }, [initialItems, initialSelectedId, initialType]);

  function selectItem(id: string) {
    setSelectedId(id);
    setFile(null);
    setMessage("");
    if (!id) {
      setDraft(makeBlankItem(initialType));
      setTagText("");
      return;
    }
    const item = items.find((entry) => entry.id === id) || makeBlankItem(initialType);
    setDraft(item);
    setTagText(tagsToText(item.tags));
  }

  function resetForm() {
    setSelectedId("");
    setDraft(makeBlankItem(initialType));
    setTagText("");
    setFile(null);
    setMessage("");
  }

  function duplicateSelectedItem() {
    if (!selectedId) return;
    const baseName = draft.name || "素材";
    const copyCount = items.filter((item) => item.name.startsWith(`${baseName} 副本`)).length + 1;
    const copyName = `${baseName} 副本${copyCount > 1 ? ` ${copyCount}` : ""}`;
    setSelectedId("");
    setDraft({ ...draft, id: "", name: copyName });
    setTagText(tagsToText(draft.tags));
    setFile(null);
    setMessage("已复制为新素材草稿，修改后点击“新增素材”即可保存。");
  }

  function updateField<K extends keyof KnowledgeItem>(key: K, value: KnowledgeItem[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] || null;
    if (selectedFile && selectedFile.size > MAX_PREVIEW_UPLOAD_BYTES) {
      event.target.value = "";
      setFile(null);
      setMessage(
        `文件太大：${bytesToMB(selectedFile.size)}MB。当前最大支持 ${bytesToMB(
          MAX_PREVIEW_UPLOAD_BYTES,
        )}MB，请先压缩视频或截短后再上传。`,
      );
      return;
    }

    setFile(selectedFile);
    setMessage("");
  }

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginMessage("");
    const formData = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "登录失败");
      setAuthenticated(true);
    } catch (error: any) {
      setLoginMessage(error.message || "登录失败");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || deleting) return;
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
    formData.set("stability", String(draft.stability));
    formData.set("order", String(draft.order || ""));
    formData.set("useCase", draft.useCase);
    formData.set("avoid", draft.avoid || "");
    formData.set("previewUrl", draft.previewUrl || "");
    formData.set("previewMimeType", draft.previewMimeType || "");
    formData.set("posterUrl", draft.posterUrl || "");
    if (file) formData.set("previewFile", file);

    try {
      const adminToken = new URLSearchParams(window.location.search).get("adminToken") || "";
      const headers = adminToken ? { "x-admin-token": adminToken } : undefined;
      const res = await fetch("/api/admin/library", { method: "POST", body: formData, headers });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
      setItems(data.items);
      onItemsChanged?.(data.items);
      setDraft(data.item);
      setSelectedId(data.item.id);
      setTagText(tagsToText(data.item.tags));
      setFile(null);
      setMessage("已保存，前台知识库会使用这条本地数据。");
    } catch (error: any) {
      setMessage(error.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!selectedId) return;
    const itemName = draft.name || "当前素材";
    if (!window.confirm(`确定删除「${itemName}」吗？这个操作会同时删除本地预览文件。`)) return;

    setDeleting(true);
    setMessage("");

    try {
      const adminToken = new URLSearchParams(window.location.search).get("adminToken") || "";
      const headers = adminToken ? { "x-admin-token": adminToken } : undefined;
      const url = `/api/admin/library?id=${encodeURIComponent(selectedId)}${
        adminToken ? `&adminToken=${encodeURIComponent(adminToken)}` : ""
      }`;
      const res = await fetch(url, { method: "DELETE", headers });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "删除失败");
      setItems(data.items);
      onItemsChanged?.(data.items);
      resetForm();
      setMessage("已删除素材。");
    } catch (error: any) {
      setMessage(error.message || "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  if (!embedded && (!authChecked || !authenticated)) {
    return (
      <section className="space-y-6">
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs uppercase text-cyan-200/70">Local Admin</p>
          <h1 className="mt-1 text-3xl font-black text-white">素材库后台</h1>
          <p className="mt-2 text-sm text-slate-400">请先登录，再上传、编辑或删除素材。</p>
        </div>
        <form onSubmit={onLogin} className="glass-panel max-w-md rounded-2xl p-5">
          <div className="space-y-3">
            <input name="username" className="control-input w-full rounded-xl px-3 py-3 text-sm" placeholder="账号" autoComplete="username" />
            <input name="password" type="password" className="control-input w-full rounded-xl px-3 py-3 text-sm" placeholder="密码" autoComplete="current-password" />
          </div>
          <button type="submit" className="primary-neon mt-4 w-full rounded-xl px-5 py-3 font-bold" disabled={!authChecked}>
            {authChecked ? "登录" : "检查登录状态..."}
          </button>
          {loginMessage && <p className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">{loginMessage}</p>}
        </form>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      {!embedded && (
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs uppercase text-cyan-200/70">Local Admin</p>
          <h1 className="mt-1 text-3xl font-black text-white">素材库后台</h1>
          <p className="mt-2 text-sm text-slate-400">
            在这里上传图片、GIF、MP4 或 WebM，并修改前台卡片与详情抽屉里的描述、标签和提示词。
          </p>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-panel rounded-2xl p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="block text-sm font-semibold text-white">选择已有素材</label>
            <div className="flex flex-wrap justify-end gap-2">
              {embedded && onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10"
                >
                  关闭
                </button>
              )}
              {selectedId && (
                <button
                  type="button"
                  onClick={duplicateSelectedItem}
                  className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/16 bg-cyan-300/8 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/14"
                >
                  <Copy className="h-4 w-4" />
                  复制
                </button>
              )}
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/16 bg-cyan-300/8 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/14"
              >
                <PlusCircle className="h-4 w-4" />
                新增
              </button>
            </div>
          </div>
          <select value={selectedId} onChange={(event) => selectItem(event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm">
            <option value="">新建素材</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <div className="mt-5">
            <PreviewAnimation item={selectedPreview} type={selectedPreview.previewType} />
          </div>
          <p className="mt-4 text-xs leading-6 text-slate-500">
            上传文件后会保存到 `public/previews`，数据保存到 `data/knowledge-items.json`。
          </p>
        </div>

        <form onSubmit={onSubmit} className="glass-panel rounded-2xl p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">类型</span>
              <select value={draft.type} onChange={(event) => updateField("type", event.target.value as KnowledgeType)} className="control-input w-full rounded-xl px-3 py-3 text-sm">
                {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
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
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">名称</span>
              <input value={draft.name} onChange={(event) => updateField("name", event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm" placeholder="例如：黑影遮挡转场" />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-white">描述</span>
              <textarea value={draft.description} onChange={(event) => updateField("description", event.target.value)} className="control-input h-24 w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">标签，用逗号分隔</span>
              <input value={tagText} onChange={(event) => setTagText(event.target.value)} className="control-input w-full rounded-xl px-3 py-3 text-sm" />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">排序</span>
              <input
                type="number"
                min="1"
                value={draft.order || ""}
                onChange={(event) => updateField("order", event.target.value ? Number(event.target.value) : undefined)}
                className="control-input w-full rounded-xl px-3 py-3 text-sm"
                placeholder="留空则自动排到最后"
              />
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
            <label className="md:col-span-2 rounded-xl border border-dashed border-cyan-300/24 bg-cyan-300/[0.04] p-4">
              <span className="flex items-center gap-2 text-sm font-semibold text-white"><UploadCloud className="h-4 w-4 text-cyan-200" /> 上传预览文件</span>
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" onChange={onFileChange} className="mt-3 block w-full text-sm text-slate-300" />
              {file && <p className="mt-2 text-xs text-cyan-100">已选择：{file.name}（{bytesToMB(file.size)}MB）</p>}
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button type="submit" disabled={saving || deleting} className="primary-neon inline-flex items-center gap-2 rounded-xl px-5 py-3 font-bold disabled:opacity-60">
              <Save className="h-4 w-4" /> {saving ? "保存中..." : selectedId ? "保存修改" : "新增素材"}
            </button>
            {selectedId && (
              <button
                type="button"
                onClick={onDelete}
                disabled={saving || deleting}
                className="inline-flex items-center gap-2 rounded-xl border border-red-400/24 bg-red-500/10 px-5 py-3 font-bold text-red-100 transition hover:bg-red-500/16 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "删除中..." : "删除素材"}
              </button>
            )}
          </div>
          {message && <p className="mt-4 rounded-xl border border-cyan-300/12 bg-cyan-300/[0.04] p-3 text-sm text-slate-300">{message}</p>}
        </form>
      </div>
    </section>
  );
}
