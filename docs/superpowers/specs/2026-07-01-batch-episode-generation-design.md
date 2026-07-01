# 批量剧集生成设计

## 状态

已批准方向，待实现计划拆分。

## 背景

Local Director 现在把 `Project` 当作整部剧或系列项目，把 `ProjectVersion` 当作第几集。工作台可以生成单集视频提示词并保存到项目；我的项目页可以在同一项目下继续新建一集；Nest 项目服务会从已保存剧集里提取 `episodeSummary`、`endingState`、`characterState`、`memoryJson`、`MemoryItem`、`CharacterProfile` 和 `StoryLoop`，再通过 `fetchDirectorContextFromNest(projectId, currentScript)` 给下一集生成提供项目级记忆。

新需求是在工作台增加“生成集数”选择，最多 30 集，支持一次给新项目生成多集，也支持给已有项目续写多集，并且每一集都要基于前面已保存剧集的记忆继续生成。

## 目标

- 工作台增加 `生成集数` 控件，范围 `1-30`，默认 `1`。
- 选择 `1` 时保持现有单集体验。
- 选择 `2-30` 时进入批量剧集生成流程。
- 支持新项目批量生成：输入项目总方向后，一次生成第 1 集到第 N 集。
- 支持已有项目批量续写：从当前项目最后一集之后继续生成 N 集。
- 每集必须按顺序生成、保存、更新记忆，再生成下一集。
- 已完成剧集必须即时保存，后续失败不能让前面成功剧集丢失。
- 失败后允许从失败集重试并继续。

## 非目标

- 不做 30 集并发生成，因为并发会破坏剧集记忆链。
- 不让一次 Codex 调用直接生成 30 集完整结果，因为容易变成粗略大纲，且保存失败风险高。
- 不改变现有单集生成、项目保存、分镜图生成和合规化的主链路。
- 不在第一版里自动生成 30 集分镜图。批量剧集生成只负责视频提示词和剧集记忆，分镜图仍按单集触发。

## 推荐架构

采用“批量剧集任务 + 顺序生成 worker”的架构。

流程如下：

```text
用户输入总文案 / 新阶段剧情方向
-> 选择生成集数 N
-> 创建 BatchEpisodeJob
-> 如无 projectId，先生成并保存第 1 集，创建新 Project
-> 每集生成前读取最新 directorContext
-> 调用视频提示词生成
-> 保存 ProjectVersion
-> Nest 更新项目记忆
-> 继续下一集
-> 全部完成或停在失败集
```

关键原则是“生成一集，保存一集，刷新记忆，再生成下一集”。

## 前端设计

### 工作台控件

在工作台输入框底部工具栏增加一个集数按钮：

```text
集数 1
```

点击后打开小弹层：

```text
生成集数
[-] 1 [+]

快捷选择：
1集  3集  5集  10集  20集  30集
```

交互规则：

- 默认 `1`。
- 最小 `1`，最大 `30`。
- 当集数为 `1` 时，发送按钮和现有单集逻辑保持不变。
- 当集数大于 `1` 时，发送按钮仍使用同一个入口，但状态文案显示批量语义。

### 生成中状态

批量生成时显示：

```text
正在生成第 7 / 30 集
已保存 6 集，正在基于第 6 集记忆继续生成
```

成功后显示：

```text
已生成 30 / 30 集，已保存到项目
```

部分失败时显示：

```text
第 12 集生成失败。已保留前 11 集，可以重试第 12 集并继续。
```

### 我的项目联动

从项目页点“新建一集”回到工作台时，如果用户选择 30 集，表示从该项目最新集数后继续生成 30 集。

例如项目已有 13 集，用户选择 30 集，则目标是生成第 14 集到第 43 集。

## API 设计

新增 Next API：

```text
POST /api/episode-batch/jobs
GET  /api/episode-batch/jobs/:jobId
POST /api/episode-batch/jobs/:jobId/cancel
POST /api/episode-batch/jobs/:jobId/retry
```

创建任务请求：

```json
{
  "script": "用户输入的总文案或续写方向",
  "episodeCount": 30,
  "duration": "auto",
  "projectId": "可选，传入则续写已有项目",
  "versionId": "可选，通常不传，批量生成默认追加新集"
}
```

创建任务响应：

```json
{
  "ok": true,
  "job": {
    "id": "episode-batch-job-...",
    "status": "pending",
    "episodeCount": 30,
    "completedCount": 0,
    "projectId": null,
    "currentEpisodeNumber": null
  }
}
```

查询任务响应：

```json
{
  "ok": true,
  "job": {
    "id": "episode-batch-job-...",
    "status": "running",
    "episodeCount": 30,
    "completedCount": 7,
    "failedAtIndex": null,
    "projectId": "...",
    "currentEpisodeNumber": 8,
    "versions": [
      {
        "versionId": "...",
        "versionNumber": 1,
        "title": "..."
      }
    ],
    "error": null
  }
}
```

任务状态：

```text
pending
running
completed
partial_failed
cancelled
```

## 队列与 worker 设计

新增本地文件队列，模式参考现有 `video-prompt-codex-queue` 和 `storyboard-codex-queue`：

```text
.tmp-episode-batch-codex/
  jobs/
  logs/
```

新增脚本：

```text
scripts/episode-batch-worker.mjs
```

新增命令：

```text
npm run episode-batch:worker
```

worker 只认领一个批量任务，但任务内部逐集处理。第一版不需要并发，因为记忆链要求顺序。

每一集内部可以沿用现有视频提示词生成能力：

```text
createVideoPromptCodexJob
-> video-prompt:codex-worker
-> completed result
-> saveAnalysisProjectToNest
```

也可以在后续版本把“视频提示词 job + 保存项目”封装成内部函数，减少前端轮询复杂度。

## 剧集规划

批量生成大于 1 集时，先生成一个轻量的剧集规划，不直接当成最终结果。

规划结构：

```json
{
  "seriesGoal": "本批次整体叙事目标",
  "episodes": [
    {
      "index": 1,
      "titleHint": "事件引入",
      "storyGoal": "建立人物和核心冲突",
      "memoryFocus": "需要留给下一集的状态"
    }
  ]
}
```

每集正式生成时，把对应 `episodePlan` 注入 `script` 或 `directorContext` 附加指令里：

```text
这是批量生成任务中的第 7 / 30 集。
本集目标：...
必须承接前面已保存剧集的结尾状态。
不要总结全部 30 集，只生成当前这一集完整视频提示词。
```

## 记忆链规则

每集生成前必须重新读取项目上下文：

```text
fetchDirectorContextFromNest(projectId, currentEpisodeScript)
```

不能复用上一次前端缓存的 context。

每集保存后必须让 Nest 写入：

```text
ProjectVersion
StoryboardShot
episodeSummary
endingState
characterState
memoryJson
contextSnapshot
MemoryItem
CharacterProfile
StoryLoop
Project.storyBible
Project.contextSummary
ProjectVisualEntity 候选
```

下一集只能基于已经保存成功的上一集继续。

## 新项目与已有项目

### 新项目批量生成

第一集没有 `projectId`。第 1 集生成完成后调用现有项目保存接口，拿到 `projectId`。后续第 2 集开始都用这个 `projectId` 追加保存。

### 已有项目批量续写

任务创建时传入 `projectId`。worker 生成第 1 个批量项前先读取项目详情或生成上下文，确认已有最后集数。保存时不传 `versionId`，让 Nest 按现有规则追加下一集。

## 错误与恢复

如果某集失败：

- 已完成剧集保持已保存。
- 批量任务进入 `partial_failed`。
- 记录 `failedAtIndex`、`currentEpisodeNumber`、`error`。
- 前端显示失败集和已保存集数。
- 用户可以点击“重试并继续”。

重试规则：

```text
从 failedAtIndex 对应的集继续
重新读取最新 directorContext
不覆盖已经保存成功的前面剧集
```

取消规则：

- 已保存剧集不删除。
- 任务状态改为 `cancelled`。
- 页面提示“已停止，前 N 集已保存”。

## 数据模型

第一版可以先用文件队列保存批量任务状态，不必立刻新增 Prisma 表。

任务 JSON 字段建议：

```ts
type EpisodeBatchJob = {
  id: string;
  status: "pending" | "running" | "completed" | "partial_failed" | "cancelled";
  script: string;
  duration: string;
  episodeCount: number;
  projectId: string | null;
  completedCount: number;
  currentEpisodeNumber: number | null;
  failedAtIndex: number | null;
  episodePlan: EpisodePlan | null;
  versions: Array<{
    versionId: string;
    versionNumber: number;
    title: string;
  }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
```

后续如果需要跨进程、跨机器、可审计的长期任务历史，再迁移到 Prisma。

## 测试计划

需要补以下测试：

- Dashboard 显示生成集数控件，范围 `1-30`。
- 集数为 `1` 时仍走现有单集 `requestAnalysis`。
- 集数大于 `1` 时创建批量任务。
- 批量任务 API 支持 create / poll / cancel / retry。
- 新项目批量生成时，第 1 集保存后把返回的 `projectId` 用于后续集。
- 已有项目批量续写时，不传 `versionId`，始终追加新集。
- worker 每集生成前都会重新获取 director context。
- 某集失败后任务进入 `partial_failed`，已保存剧集不丢。
- 重试从失败集继续。
- `episodeCount > 30` 被拒绝。

## 实现顺序

1. 增加工作台集数 UI，但先只在前端保存状态。
2. 增加批量任务 API 和文件队列。
3. 增加批量 worker，先跑 mock/provider 路径。
4. 接入现有 Codex 视频提示词 job。
5. 接入项目保存和每集记忆刷新。
6. 接入前端轮询、取消、重试。
7. 补全失败恢复和最终状态展示。

## 边界

- 单次最多 30 集，API 和前端都要限制。
- 批量生成必须顺序执行。
- 每集保存成功才进入下一集。
- 第 1 集失败时，新项目不应创建空项目。
- 第 N 集失败时，前 N-1 集必须可在我的项目中看到。
- 批量任务不能覆盖已有剧集，只追加新集。
- 用户关闭页面后，worker 仍可继续；重新打开后可以通过 jobId 查询进度。
