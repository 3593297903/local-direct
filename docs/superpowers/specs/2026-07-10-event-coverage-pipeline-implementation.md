# 多段事件覆盖链路实施记录

## 当前状态

- 默认阶段：`shadow`
- 紧急停止：`BATCH_EVENT_COVERAGE_EMERGENCY_STOP=true`
- 正常段不调用 Judge。
- 事件歧义不允许进入路径修复。
- 只有 `patch-active` 允许修复已经确认缺失或冲突的事件槽。

## 生成链路

```text
Render Pack 结果
-> 规范化与本地确定性 patch
-> Quality Gate
-> Outcome Router
   -> accept
   -> quality path patch
   -> Judge wave
   -> confirmed event path patch
   -> regenerate missing/structurally invalid result
   -> needs review
-> 段级缓存
-> 顺序幂等保存
```

## 灰度阶段

| 阶段 | 行为 |
| --- | --- |
| `shadow` | 只记录事件覆盖结果，不改变保存或修复。 |
| `local` | 本地确定覆盖可放行；歧义进入待检查。 |
| `judge-shadow` | 调用 Judge，但不使用 Judge 结果改变提示词或保存。 |
| `judge-active` | Judge 确认覆盖时放行；缺失、冲突或不确定仍待检查。 |
| `patch-active` | 只有 Judge 或确定性证据确认缺失/冲突后，才允许一次槽级路径 patch。 |

## 不变量

1. `requiredEvents` 仅用于剧情理解，不做逐字匹配。
2. `requiredEventSlots` 是程序覆盖判断的唯一结构化来源。
3. mixed blocking 先修非事件叶子字段，复检后再裁决事件歧义。
4. Judge 只返回决策和原字段可验证引用，不返回提示词或修复文本。
5. Codex patch 只能改授权叶子路径；未授权字段必须深度相等。
6. `workflow.fullVideoPrompt` 和 `filmScript` 只由本地 canonical builder 重建。
7. 同一 `batchId + segmentIndex + slotId` 最多一次 Codex 事件 patch。
8. 成功段立即写服务端缓存；项目保存使用 `batchId + segmentIndex` 幂等键。

## 正式启用前验收

分别用固定 10、20、30 段样本跑三轮基线与灰度对照，记录：

- 总生成时间和 P95
- Judge 调用数
- Codex patch 数
- 误修复数
- 真实漏事件数
- Sidecar 有效率
- 提示词质量分
- 字段和镜头完整率

只有满足以下条件，才把环境从 `shadow` 推进到 `patch-active`：

- 语义误修复下降至少 80%
- 提示词质量不低于基线
- 真实漏事件检出率不降低
- 中位总耗时不增加
- P95 不超过基线 5%
- 正常段 Judge 调用为 0
- 完整结果 fallback 为 0
