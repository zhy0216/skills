# 手动派发 Linear issue

供手动调用 finish-linear-todo 或 linear-auto-dev 的调用者使用。调用者留在原 checkout，派发一个 Herdr 执行 agent 完成该 issue 的完整流程，并持续等待、复核；watcher 的阶段 agent 不使用本流程。

## 检查与上下文

先读取 [Herdr skill](../../herdr/SKILL.md)，确认 `HERDR_ENV=1`，再用 `herdr --help`、`herdr worktree`、`herdr agent`、`herdr pane` 核对本机语法。Herdr 不可用或当前不在 Herdr pane 中时报告具体阻塞，不退回原 checkout 实现或裸 `git worktree add`。

按 finish-linear-todo 第 1 节读取 issue、仓库约束、主分支、GitHub 远端、认证、依赖、运行锁和已有记录。新任务必须仍是约定的 Todo；当前调用者不修改 issue 状态，由执行 agent 开工前重新读回并领取。存在同 issue 的活动运行时不重复派发。

执行 agent 类型优先使用用户本次明确指定的 Codex/OpenCode，其次复用已有 context 的 `agentConfig`，没有指定时跟随当前宿主。模型、推理强度和额外参数沿用该类型的明确配置或 CLI 默认值；不要擅自切换模型或套用另一种 CLI 的参数。启动前确认所需 CLI 可用。

新运行将 context 放在 Git common directory 下的 `linear-runs/<run-id>/context.json`，路径均使用绝对路径。保存 finish-linear-todo 第 1 节的字段，并补充：

- `launchMode: "manual"`、`role: "executor"`；**不设置 `stage`**，表示执行完整 issue 流程。
- `entrySkill`：`finish-linear-todo` 或 `linear-auto-dev`，后者必须先规划、拆任务再实现。
- `agentConfig`、`agentName`、`paneId`；agent 名使用唯一且符合 `[a-z][a-z0-9_-]{0,31}` 的短名称。
- `skill`：finish-linear-todo/SKILL.md 的绝对路径；`helper`：共用 linear-issue.ts 的绝对路径。
- `resultPath`：`runDir/result.json`；`resultSchemaPath`：[finish-result.json](../schemas/finish-result.json) 的绝对路径。

worktree、workspace 和 pane 字段必须取自下面的真实 Herdr 返回值，创建后逐步写入 context，再向执行 agent 发送任务。凭据不写入 context。

## 创建 worktree 并派发

从已记录的 commit 创建独立分支和 Herdr workspace，保持用户焦点不变：

```bash
herdr worktree create --cwd "$repo" --branch "$branch" \
  --base "$baseSha" --label "$identifier" --no-focus
```

读取 JSON 的 `result.workspace.workspace_id`、`result.root_pane.pane_id`、`result.worktree.path` 和 `result.worktree.branch`。核对返回分支与计划一致、worktree 属于目标仓库且 HEAD 等于 `baseSha`；不猜路径或 ID，不再执行一次 `git worktree add`。

在返回的 root pane 旁创建专用执行 pane，显式注入工作目录和上下文：

```bash
herdr pane split "$rootPane" --direction right --cwd "$worktree" \
  --env "LINEAR_WATCH_CONTEXT=$contextPath" --no-focus
```

从 `result.pane.pane_id` 读取 `paneId` 并保存。如果使用了 `LINEAR_CLI_BIN`、`LINEAR_CLI_PROFILE` 或自定义 CLI 的 PATH，一并通过 `--env` 传入，避免新 pane 使用错误的 workspace profile。`HERDR_*` 身份变量由 Herdr 注入，不从调用者复制。

在该 pane 启动解析后的 agent 类型：

```bash
herdr agent start "$agentName" --kind "$agentKind" --pane "$paneId"
```

有明确的原生 CLI 参数时作为独立 argv 放在 `--` 后，不能把 issue 内容、模型名或参数拼成 shell 程序。agent 就绪后通过 `herdr agent prompt` 发送任务；提示包含 issue 标识、context 与 skill 的绝对路径、用户约束，以及以下交接要求：

```text
你是本 issue 的手动执行 agent。先读 LINEAR_WATCH_CONTEXT 指向的 JSON 和其中 skill。
这是 launchMode=manual、role=executor、没有 stage 的完整流程。
核对当前 pane、worktree、仓库和分支与 context 一致，复用现有 workspace/worktree；
不要再次派发本 issue，也不要修改原 checkout。
按 skill 完成领取、实现、验证、发布产物、推送 issue 分支、开 PR 和 Linear 收尾。
entrySkill=linear-auto-dev 时，先完成 Linear plan 和任务队列。
将符合 resultSchemaPath 的结果 JSON 写入 resultPath，并作为最终回答。
成功或失败都保留 worktree、分支和 workspace，不合并 PR，不自行关闭执行 pane。
```

执行 agent 必须核对 `HERDR_WORKSPACE_ID`、`HERDR_PANE_ID`、`git rev-parse --show-toplevel`、Git common directory 和当前分支与 context 对应；身份不符时报告阻塞，不能借 context 在原 pane 直接执行。

## 等待、复核与恢复

调用者发送提示后持续监控 `herdr agent get/read/wait`，单次等待不超过 60 秒，期间保持用户进度更新。等待超时不表示任务失败；不要重复发送原任务，也不要仅因 agent 长时间工作而重启它。遇到 blocked 先读取实际原因，按 Herdr skill 处理，不盲目发送按键。

agent 结束后读取 `resultPath`，按 schema 核对 issue、outcome 和交付字段。缺结果时可向同一 agent 补发一次仅写结果文件的提醒；仍缺失则报告未完成并保留现场。确认前一次执行已结束、准备派发恢复或返工任务时，先将旧结果移到带时间标记的记录中，防止把上次结果当成本次交付。

声明完成前，调用者独立核对 worktree 分支与 HEAD、干净状态、origin 上 issue 分支的 commit、PR 的 base/head/commit 与验证产物、Linear completed 状态以及属于该 issue 且包含 commit 的验证评论。发现具体缺口时交回同一 agent 修正；没有真实完成证据时不标记成功。

记录结果后，只关闭本次创建且已结束工作的执行 pane；保留 root pane、Herdr workspace、worktree、本地和远程分支。失败时保留日志与上下文，不能因收尾失败重新实施或清理现场。

明确恢复时复用原 `runId`、branch、worktree、base 和已发布产物。先核对运行锁和原 agent，仍在运行则继续监控；若 worktree 仍在而 workspace 已不存在，可用 `herdr worktree open --cwd "$repo" --path "$worktree" --label "$identifier" --no-focus` 打开已有工作树，读回并更新 workspace/rootPane，再启动新的执行 pane。worktree 缺失或来源不符时报告具体问题，不另建同 issue 分支。已有 PR 或 Linear 已完成时，只核对并补齐缺失的收尾。
