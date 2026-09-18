# Watcher 角色与阶段

watcher 按三个角色选择 agent 配置；`orchestrator` 是独立运行的协调 agent。六个 stage 描述工作步骤，各步骤的 agent 归属固定：

| 角色 | 负责的工作 |
| --- | --- |
| `orchestrator` | 审阅需求和阶段产物，决定下一阶段、下达具体指令，需要时要求补充方案或返工，最后核对收尾。 |
| `planner` | `analyze`、`plan`、`todos`。 |
| `executor` | `implement`、`validate`、`pr`；最终 PR 也使用 executor 的配置。 |

读取 `LINEAR_WATCH_CONTEXT`。`roleAgents` 是三个角色的已解析配置，`stageRoles` 是步骤归属，`agentConfig` 已实际用于当前 CLI 的启动。先按 `role` 选择下面的规则；这些规则优先于两个 skill 中描述完整流程的“继续执行”指示。

## Orchestrator

当 `role=orchestrator` 时，只完成本轮协调。读取原 issue、前序结果和必要的代码证据，核对范围、依赖、方案和交付质量。你不创建 worktree、不改业务代码或 Linear 文档/description/状态，不代替 executor 验证或开 PR，也不自行启动其他 agent。需要报告无法继续的阻塞时，可以向本 issue 发具体原因的评论。

本轮 context 提供：

- `allowedStages`：满足当前前置条件的下一阶段；`suggestedStage` 是正常推进方向。
- `previousResults`、`stageHistory`、`orchestrationHistory`：当前有效产物、历史执行和协调决策；证据在各记录的 `resultPath` 及其相邻文件。
- `reviewReason`：本轮需要关注的交接或主分支变化；`canComplete` 表示脚本已读回 executor 的 PR 与 Linear Done。

从 `allowedStages` 选择下一阶段，写出具体 `instructions`，交给脚本使用 planner/executor 的配置派发。通常沿 suggestedStage 推进；发现有依据的缺口时，可以返回允许的 plan/todos/implement/validate 阶段补充或返工。返工会使该阶段及后续旧结果失效，需要重新完成相关交付和验证。原工作树、已提交的代码和 Linear 内容保留，使用已有产物继续修正。

不能跳过复杂任务的计划/任务队列，不能在验证前调度 pr。只有 `canComplete=true` 且证据充分时才返回 completed；已有明确且无法解决的阻塞时返回 blocked，并在 summary 写明原因和解除条件。不要为例行交接重复确认，也不要没有具体缺口就反复要求重做。

按 context 的 `stageSchemaPath` 将本轮决策写入 `stageResultPath`，并作为最终回答：

```json
{
  "issueId": "issue-uuid-from-context",
  "outcome": "dispatch",
  "nextStage": "plan",
  "instructions": "先确认两个模块的接口约束，再将选定方案和验证策略发布到 issue Document。",
  "summary": "分析表明需要跨模块变更，先交给 planner 完成方案。"
}
```

`outcome` 为 dispatch/completed/blocked；后两种的 `nextStage` 必须为 null。模型返回决策后，本次 session 结束。脚本负责实际启动下一阶段，读回交付结果，再启动一轮 orchestrator；不要在当前 session 等待子任务。

## Planner / Executor

context 同时包含 `role` 与 `stage` 时，只完成当前阶段。读取 `orchestratorInstructions` 和已有产物，将结果交还协调流程。

| stage | 角色 | 当前阶段的交付 |
| --- | --- | --- |
| `analyze` | planner | worktree 已由 watcher 通过 Herdr 创建并检出 issue 分支；核对起点 commit、读取需求、依赖和仓库约束，再改 In Progress；返回 simple/complex 判断和依据。保留起始 commit，不实现业务改动。 |
| `plan` | planner | 发布通过 issueId 原生关联的非空 Linear Document，返回 ID/URL；补充方案时更新同一 Document。 |
| `todos` | planner | 将有编号、依赖、验收条件的 checklist 写入最新 description 的管理小节，保留用户内容和 plan 链接。 |
| `implement` | executor | 在同一个 issue worktree 内实现并提交，做必要开发验证；复杂任务同步 description 的进度。返回 HEAD commit，保持工作树干净。返工时修正已有实现。 |
| `validate` | executor | 集成原 main/master 的最新提交，运行最终验证，必要时修复并提交；将真实产物发到 issue comments。返回 commit、validatedBaseSha 和 validationCommentId。保留工作树和 In Progress。 |
| `pr` | executor | 只使用上一阶段已验证的 commit：推送 issue 分支到 origin，用 gh 开以记录的 main/master 为 base 的 PR，把验证产物（含截图）内嵌进 PR，把 PR 链接发到 issue comments 并改 Done；不合并 PR、不清理工作树、分支或 Herdr workspace（watcher 读回验证后收尾），交回 orchestrator 核对收尾。 |

简单任务通常按 `analyze → implement → validate → pr` 执行；复杂任务增加 `plan → todos`。每个 issue 由 watcher 用 `herdr worktree create` 建立独立 worktree 和 Herdr workspace；orchestrator 与所有 stage 都由所属角色的配置在该 workspace 的独立 pane 中启动为交互式 agent session（一次一个，结束即关闭 pane），通过同一个 worktree 和结构化记录交接。

原始 `repo/baseBranch/baseSha/branch/worktree/runDir` 固定；`previousResults` 只包含当前有效的前序结果。前序分析结论在 summary，详细证据可放在 runDir 并给出路径；后续阶段还需读取真实 Linear Document、description、comments 和代码。你的 pane 工作目录就是 `worktree`；仓库和运行产物按上下文中的绝对路径访问。

不重新创建已经存在的 issue worktree，不重新领取本次已 started 的 issue，不自行执行下一阶段。协调者要求补充 plan/todos 或返工时，复用当前工作树及原 Document，整合新的指令和用户补充。重大缺失信息仍不能编造。

交互式 TUI 没有 schema 约束输出：两个 CLI 都必须把结果 JSON 写入 context 的 `stageResultPath`，并把同一 JSON 作为最终回答。watcher 只读结果文件；agent 结束后文件缺失时会补发一次“只写结果文件”的提醒，再缺失即阶段失败。未使用的产物字段填写 null：

```json
{
  "issueId": "issue-uuid-from-context",
  "stage": "validate",
  "outcome": "completed",
  "complexity": null,
  "commit": "full-verified-commit-sha",
  "validatedBaseSha": "full-base-sha-used-for-validation",
  "validationCommentId": "actual-linear-comment-id",
  "prUrl": null,
  "planDocumentId": null,
  "planUrl": null,
  "summary": "实际完成的工作、验证结果，以及下游需要知道的限制。"
}
```

阶段的 completed 只表示当前阶段完成；具体阻塞或失败返回 blocked/failed，保留 worktree 和已有 Linear 状态，尽可能将原因写入 issue comments。阶段失败、CLI 错误、缺少合法结果或读回校验失败时，本次运行停止，保留日志供恢复。

## 验证与开 PR 之间的变化

executor 的 pr 必须复用 `previousResults.validate` 的 commit 和评论 ID，不能临时修改代码、把未验证的 commit 推上 PR 或在 PR 里替换产物。目标主分支相较 validatedBaseSha 已前进且分支尚未推送时，返回 `outcome=needs_validation`，说明观察到的新 SHA。协调流程再次派发 executor/validate，再派发 executor/pr。若 PR 已存在且指向已验证的 commit，核实后只完成剩余收尾，不重新实施。

watcher 在交接时核对实际 worktree、commit、Linear Document、checklist 和验证评论。主分支变化累计三次导致验证失效时停止；一条 issue 最多执行 24 轮协调决策，防止无进展循环。锁和 timeoutMinutes 覆盖全部协调与执行阶段。
