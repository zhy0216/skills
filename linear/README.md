# Linear 自动开发

一组 skill 可以放在 `~/.agents/skills/linear/` 下，每个 skill 保留自己的 `SKILL.md`。`linear/` 本身不放入口 `SKILL.md`，只作为分组目录；watcher 还会将入口的绝对路径传给所选 agent，支持新建 skill 尚未刷新到当前会话的情况。

```text
linear/
├── finish-linear-todo/SKILL.md
├── linear-auto-dev/SKILL.md
├── scripts/linear-issue.ts
├── scripts/linear-client.ts
├── scripts/agents.ts
├── scripts/stages.ts
├── schemas/finish-result.json
├── schemas/stage-result.json
├── schemas/orchestrator-result.json
├── references/linear-cli.md
├── references/stages.md
└── linear-watch.example.json
scripts/linear-watch.ts
scripts/config.json
scripts/config.codex.example.json
scripts/config.opencode.example.json
```

运行需要 Bun（本机验证版本 1.4.2，必须提供原生 `Bun.cron`）、已认证的 `linear-cli`、Git、一个正在运行的 Herdr session，以及配置中实际使用的 Codex CLI 或 OpenCode CLI（由 Herdr pane 的 shell 在 PATH 中解析；配置里写 `codexBin`/`opencodeBin` 时其目录会被注入 pane PATH）。本机核对的 CLI 版本为 Codex 0.153.4、OpenCode 1.18.29、Herdr 以 `herdr --version` 为准；运行时没有 npm 依赖。参阅 [Bun cron 文档](https://bun.com/docs/runtime/cron) 和 [Codex skills 文档](https://learn.chatgpt.com/docs/build-skills)。

## 配置并运行

默认配置已放在 `scripts/config.json`，Team 为 `EZT`；先把 `routes[].repo` 的占位值替换为实际仓库路径。也可以复制 `linear-watch.example.json` 创建其他配置，填写本地仓库和 Linear 范围。`repo` 和 `stateDir` 的相对路径以配置文件所在目录为基准，JSON 中不展开 `~`；CLI 可执行文件使用 PATH 中的名称或绝对路径。

同目录还有两个完整示例：[全部使用 Codex](../scripts/config.codex.example.json)、[全部使用 OpenCode](../scripts/config.opencode.example.json)。Codex 示例为三个角色分别设置 medium/high/xhigh，并通过 `--ephemeral` 演示额外参数；OpenCode 示例使用内置 build agent，给各角色设置 session 标题。两者的 `model: null` 沿用各 CLI 的默认模型；OpenCode 的 `reasoningEffort: null` 沿用模型默认，指定深度时改为该模型支持的 variant。填写 repo 后可用 `--config scripts/config.codex.example.json --test` 或 `--config scripts/config.opencode.example.json --test` 选择单条试跑。

```json
{
  "routes": [
    { "repo": "/home/me/code/frontend", "team": "ENG", "project": "Web" },
    { "repo": "/home/me/code/api", "team": "ENG", "project": "API", "baseBranch": "master" }
  ],
  "timeoutMinutes": 720
}
```

每条 route 至少提供 `team` 或 `project`；两者同时提供时都必须匹配，支持 Team key/name/UUID 和 Project name/UUID。不要设置重叠路由；同一个 issue 匹配多条会报告歧义并跳过。`todoState` 默认 `Todo`，可设置实际名称或 ID。`inProgressState`、`doneState` 可指定本 Team 的状态。`baseBranch` 可选 `main`/`master`；从 feature 分支启动且无法确定原主分支时应显式设置。

可选顶层配置：`linearProfile`、`linearBin`、`codexBin`、`opencodeBin`、`herdrBin`、`herdrSocket`、`stateDir`、`defaults`、`agents`。任务全部通过 Herdr 执行：每条 issue 用 `herdr worktree create` 建立独立 worktree 与 workspace，orchestrator/planner/executor 的每个阶段都在该 workspace 的专用 pane 里以交互式 agent 启动（Codex 带 YOLO 参数、OpenCode 带 `--auto`），一次一个，结束即关闭 pane；成功后 watcher `workspace close` 并删除 worktree 和分支，失败时保留现场。`herdrSocket` 选择目标 session 的 socket（默认取 `HERDR_SOCKET_PATH`，否则 `~/.config/herdr/herdr.sock`，即 default session；命名 session 用其 `sessions/<name>/herdr.sock`）。`timeoutMinutes` 默认 720，是一条 issue 所有阶段共用的执行时限；允许任务跨过下一个四小时刻度，期间用锁防止重入。旧顶层 `model` 仍兼容，新配置请使用 `defaults.model`。

### 三个角色的 agent 配置

配置只需指定 `agents.orchestrator`、`agents.planner`、`agents.executor`，`defaults` 提供它们共享的默认值。步骤归属如下：

| 角色 | 负责的工作 |
| --- | --- |
| `orchestrator` | 独立协调 agent：审阅需求与阶段产物，决定下一步、下达指令、要求补充方案或返工，核对最终收尾。 |
| `planner` | `analyze`、`plan`、`todos`。 |
| `executor` | `implement`、`validate`、`merge`，包括最终合并。 |

`scripts/config.json` 默认三个角色都是 `{}`，继承 Codex、当前 CLI 模型和 xhigh。混用 Codex/OpenCode 时，可以这样覆盖：

```json
{
  "defaults": {
    "agent": "codex",
    "model": null,
    "reasoningEffort": "xhigh",
    "extraArgs": []
  },
  "agents": {
    "orchestrator": { "reasoningEffort": "high" },
    "planner": {
      "agent": "opencode",
      "model": null,
      "reasoningEffort": "high",
      "extraArgs": ["--agent", "build"]
    },
    "executor": {}
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `agent` | CLI 类型：`codex` 或 `opencode`。 |
| `model` | 该 CLI 可用的模型名称；OpenCode 使用 `provider/model` 格式。`null` 表示不传模型参数，沿用 CLI 的配置。 |
| `reasoningEffort` | Codex 传为 `-c 'model_reasoning_effort="…"'`，OpenCode 传为 `--variant …`。填所选模型支持的值；`null` 表示不传，由 CLI 决定。 |
| `extraArgs` | 原生 CLI 的额外参数数组，每项是一个 argv 元素，例如 `["--profile", "development"]` 或 `["--agent", "build"]`。 |

每个角色按字段覆盖 defaults。同一种 CLI 继承未指定字段；切换 CLI 类型时，模型、思考深度和额外参数重新采用目标 CLI 的内置默认值，避免把 Codex 模型或参数传给 OpenCode。Codex 的内置默认值是 `model: null`、`reasoningEffort: "xhigh"`、`extraArgs: []`；OpenCode 是 `model: null`、`reasoningEffort: null`、`extraArgs: []`。切换时需要的设置请直接写在该角色内。

`extraArgs` 整组替换继承值，`[]` 清空；其中的空格、引号、`$()` 都按字面量传入，不作为 shell 命令执行。工作目录（issue worktree）、pane 环境（含 `LINEAR_WATCH_CONTEXT`）、agent 名称和结果文件由 runner 管理，不能通过 extraArgs 覆盖；启动不使用 exec/run 子命令，直接拉起交互式 TUI。Codex 始终加 YOLO 参数 `--dangerously-bypass-approvals-and-sandbox`，OpenCode 加 `--auto`。TUI 没有 schema 约束输出：各阶段以“把符合 schema 的 JSON 写入结果文件”为交接契约，文件缺失时 runner 会补发一次仅写文件的提醒。

同一角色负责的所有步骤都使用同一份配置；merge 使用 executor。旧的 `stages` agent 配置会给出迁移提示，请改成上述三个角色，避免旧覆盖与新归属发生冲突。具体职责和交接见 [角色与阶段执行规则](references/stages.md)。

模型与思考深度的可用值取决于所选 CLI/provider/model；参考 [Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference) 和 [OpenCode CLI](https://opencode.ai/docs/cli/)。OpenCode 的 `--auto` 仍遵守显式 deny 规则，见 [权限说明](https://opencode.ai/docs/permissions/)。

在这个 skills 仓库根目录运行：

```bash
# 只读取 Linear/Git，输出匹配 issue、目标仓库、三个角色的完整配置和步骤归属。
bun scripts/linear-watch.ts --config /absolute/path/config.json --dry-run

# 单条试跑：只领取一个可执行的 Todo，按配置运行各阶段，结束后退出。
bun scripts/linear-watch.ts --config /absolute/path/config.json --test

# 立即执行一轮。
bun scripts/linear-watch.ts --config /absolute/path/config.json --once

# 立即执行一轮，然后由 Bun.cron 在进程内每四小时调度。
bun scripts/linear-watch.ts --config /absolute/path/config.json

# 用 Bun.cron 注册系统任务，进程退出/重启后仍由系统调度。
bun scripts/linear-watch.ts --config /absolute/path/config.json --install

# 删除该配置对应的系统任务。
bun scripts/linear-watch.ts --config /absolute/path/config.json --uninstall
```

`--test` 按现有优先级顺序选取一个可执行的 Todo，执行完整的实现、验证、评论和合并流程后退出；该 issue 失败时也直接退出，不再领取第二条。已锁定或状态已改变的 issue 会跳过，继续寻找可领取的候选。此模式只执行一轮，不启动 cron。

默认读取 `linear-watch.ts` 同目录的 `config.json`，不受启动时工作目录影响。配置选择优先级为 `--config` → `LINEAR_WATCH_CONFIG` → 同目录默认配置。填好默认配置后，单条试跑可直接执行 `bun scripts/linear-watch.ts --test`。Cron 表达式固定为 `0 */4 * * *`，按系统时区在 00、04、08、12、16、20 点运行。OS 模式通过 `Bun.cron(path, schedule, title)` 安装，并导出 `scheduled()` handler；Linux 需要可用的 crontab 和 cron 服务。`--install` 只注册定时任务，首次立即执行使用 `--once`。

安装时保存可执行文件绝对路径和 PATH，以适配 cron 的精简环境。API key、OAuth token 不写入生成的任务文件；系统任务需要 CLI 的持久化登录配置，或由运行环境提供凭据。安装路径不变时再次 `--install` 更新同名任务。

## 执行与恢复

每轮先完成所有分页，再按 priority、创建时间顺序派发，issue 之间顺序执行；失败不会阻止本轮其他 issue。领取 issue 后 watcher 先用 `herdr worktree create` 建立独立 worktree 和 workspace。简单任务执行 `analyze → implement → validate → merge`，复杂任务在 analyze 后增加 `plan → todos`。每次交接先运行一轮 orchestrator，它读取证据、选择下一阶段并给出指令；脚本使用所属角色的配置在该 workspace 的新 pane 中启动交互式 agent。各阶段通过同一个 worktree、Linear 产物和结构化上下文交接。最终验证产物发布到 comments 后，快进合入最初记录的本地 main/master，再标记 Done；成功读回后 watcher 关闭 workspace 并清理 worktree 和分支，失败则保留现场。只要求本地合并时不会自动 push。

orchestrator 可以要求重新规划或返工；相关后续结果会失效，需要重新验证。主分支在验证后或合并前前进时，协调流程再次派发 executor/validate 和 executor/merge。主分支变化累计三次导致验证失效时停止；一条 issue 最多运行 24 轮协调决策，超时或无进展时保留工作树和日志。

默认日志位于 `$XDG_STATE_HOME/linear-watch` 或 `~/.local/state/linear-watch`。`watcher.jsonl` 是调度日志；每条 issue 的 `runs/<issue>-<run-id>/context.json` 保存 worktree、Herdr workspace/pane、已解析的角色配置、阶段结果、执行历史和协调决策。每阶段的 `stages/<stage>-<attempt>/` 包含独立 `context.json`、`result.json` 和 `<agent 名>.tui.log`（agent 结束后抓取的 pane 转录）；`orchestrator/<turn>/` 同理保存每轮协调者的 context、决策 JSON 和转录。根目录的 `result.json` 是最终汇总，`verified.json` 是完成后的读回确认，`failure.json` 保存失败原因。

退出码 0 不会自动算完成：watcher 在交接时读回 worktree、Document、checklist 和验证评论，最终再核对主分支包含返回的 commit、Linear 已 completed，且验证评论属于该 issue 并包含该 commit。

仓库锁位于 Git common directory 的 `linear-watch.lock/`，issue 锁位于默认 state root 的 `locks/`（不随自定义日志目录变化）。锁 owner 记录当前 Herdr agent 名、paneId 和 workspaceId。SIGINT/SIGTERM 和超时会让 watcher 关闭正在运行的 worker pane（Herdr 随之回收 agent 进程），并保留日志、worktree 和 workspace。watcher 硬崩溃时其后的 agent 可能仍在 Herdr session 中运行；先 `herdr agent list` 和读 `owner.json` 核对，确认相关 pane 已消失后，再只移除对应失效锁目录。不要把仍运行的任务锁当作 stale lock。

已进入 In Progress 的失败任务不会被下一轮 Todo 扫描重复领取。手动执行 `$finish-linear-todo ISSUE` 并提供原 `context.json`，明确恢复该运行；已合并但 Linear 收尾失败时只补评论/状态。尚未领取的 Todo 在下一轮仍可处理。同一范围只在一台机器上运行 watcher；本机锁不提供跨机器原子领取。

## 验证开发改动

在 `linear/` 目录运行 `bun install` 后，执行 `bun run check` 和 `bun test`。测试使用模拟 Linear/Codex/OpenCode/Herdr CLI 和临时 Git 仓库，覆盖参数继承、三个角色经 Herdr pane 的实际派发、结果文件缺失时的一次提醒、协调返工/重新规划、单条试跑、验证重试和真实 Git 合并与 worktree 清理，不改真实 Linear issues，也不接触真实 Herdr session。
