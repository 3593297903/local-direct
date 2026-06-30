# AI Video Director SaaS

这是一个面向 AI 视频创作者的 SaaS MVP 项目：用户输入小说、短剧、广告或产品脚本后，系统会自动生成电影感分镜、镜头、运镜、转场和中文视频提示词。

## 已包含功能

- 首页 Landing Page
- SaaS 工作台 `/dashboard`
- AI 脚本分析 API `/api/analyze`
- LangGraph 视频导演工作流：输入标准化 → 知识库检索 → 模型生成 → 结果合并
- Mock 模式，无需 API Key 也能体验
- DeepSeek / OpenAI 兼容接口支持
- Claude / Anthropic 接口支持
- 转场库 / 镜头库 / 运镜库 `/library`
- 搜索、分类筛选、悬停预览、右侧详情抽屉
- 中文提示词复制
- Supabase 登录页 `/login`
- Supabase 数据库结构与 RLS 权限
- 项目保存 API 基础逻辑

## 技术栈

- Next.js App Router
- React + TypeScript
- Tailwind CSS
- Supabase Auth + Postgres + RLS
- pgvector 预留语义搜索
- LangGraph.js Agent 工作流编排
- DeepSeek / OpenAI-compatible / Anthropic API

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

打开：

```text
http://localhost:3000
```

默认 `.env.local` 里使用：

```text
AI_PROVIDER=mock
AI_WORKFLOW=langgraph
```

所以无需 API Key 也可以先跑通功能。现在 `/api/analyze` 默认会经过 LangGraph 工作流：先标准化输入，再从本地知识库检索镜头/运镜/转场/风格/公式，最后调用模型生成并合并 Agent 执行轨迹。

如果要临时退回旧版一步式调用，可以设置：

```env
AI_WORKFLOW=direct
```

## LangGraph 工作流

核心文件：

```text
lib/agent/video-director-graph.ts
```

工作流节点：

```text
normalize_input      标准化输入和总时长
retrieve_knowledge  从 data/knowledge-items.json 检索相关知识
generate_analysis   调用 DeepSeek / OpenAI-compatible / Claude / mock
finalize_result     合并知识库引用和 Agent 执行轨迹
```

返回结果会额外包含：

```text
result.usedKnowledge  本次命中的知识库条目
result.agentTrace     LangGraph 每一步执行记录
```

知识库仍然使用现有的 `data/knowledge-items.json`，后续可以把检索层换成 Supabase pgvector / LlamaIndex，而不用重写前端页面。

## 接入 DeepSeek

`.env.local`：

```env
AI_PROVIDER=deepseek
AI_MODEL=deepseek-chat
AI_API_KEY=你的 DeepSeek API Key
AI_BASE_URL=https://api.deepseek.com
```

## 接入 OpenAI

```env
AI_PROVIDER=openai
AI_MODEL=gpt-4.1-mini
AI_API_KEY=你的 OpenAI API Key
AI_BASE_URL=https://api.openai.com/v1
```

## 接入 Claude

```env
AI_PROVIDER=anthropic
AI_MODEL=claude-3-5-sonnet-latest
AI_API_KEY=你的 Anthropic API Key
ANTHROPIC_API_VERSION=2023-06-01
```

## 配置 Supabase

1. 新建 Supabase 项目
2. 打开 SQL Editor
3. 运行 `supabase/schema.sql`
4. 可选：运行 `supabase/seed.sql`
5. 在 `.env.local` 填入：

```env
NEXT_PUBLIC_SUPABASE_URL=你的 Supabase URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=你的 Supabase anon key
SUPABASE_SERVICE_ROLE_KEY=你的 service role key
```

注意：`SUPABASE_SERVICE_ROLE_KEY` 只能在服务端使用，不要暴露给前端。

## 真实 SaaS 后续建议

### 第一阶段：MVP

- 完成登录注册
- 脚本分析次数限制
- 项目保存和历史记录
- 转场/镜头库后台管理
- 免费版每日 3 次生成

### 第二阶段：知识库增强

- 给 knowledge_items 生成 embedding
- 使用 pgvector 做语义搜索
- 用户输入“现实进入回忆的转场”时自动推荐眼睛转场、强光转场、照片转场

### 第三阶段：商业化

- 接入 Stripe 或 Lemon Squeezy
- 会员计划：Free / Pro / Team
- 用量计费：按生成次数、token、项目数

### 第四阶段：视频模型衔接

- 首帧图生成
- 尾帧图生成
- Veo / Seedance / Runway API 接入
- 自动检查视频是否符合分镜
- 一键导出视频生成包

## 目录结构

```text
app/
  api/
    analyze/       AI 脚本分析接口
    library/       知识库查询接口
    projects/      项目列表接口
  dashboard/       SaaS 工作台
  library/         转场/镜头/运镜库
  login/           Supabase 邮箱登录
components/        前端组件
lib/               AI 调用、知识库、Supabase、mock 数据
types/             TypeScript 类型
supabase/          数据库 schema 和 seed
```

## 重要说明

这版是“真实 SaaS 项目骨架 + 可运行 MVP”，不是只做 UI 原型。它已经把 AI 调用层、知识库、Supabase 数据表、RLS 权限和项目保存逻辑搭好。但正式上线前，你还需要：

- 配置真实域名
- 接入支付系统
- 完善后台管理
- 做内容安全审核
- 做 API 用量限制
- 做错误日志和监控
- 为每个模型设置成本控制
