# Agent 分发规则

`auto-dev`、`make-plan`、`plan-to-todo` 和 `herdr-finish-plan` 共用本规则。这里只定义选择、传递和启动参数；读取本文件不代表调用执行 skill。

## 选择 agent

这里的 `agent` 指 CLI 类型（`codex` / `opencode`），不是 Herdr 实例名称或模型名。先确定类型，再选择该类型的模型与推理强度。

默认跟随发起流程的宿主：在 Codex 中调用就用 `codex`，在 OpenCode 中调用就用 `opencode`。以当前会话身份为准；需要辅助确认时，可在 Herdr 环境中读取调用 pane 的 agent kind。不能根据 PATH 中装了哪个 CLI、当前模型的提供商或其他 pane 来推断。只有需要宿主默认值且无法确定时才询问用户；已有明确指定或保存值时直接使用，不要兜底成 OpenCode。

每个任务的类型按以下顺序解析：

1. 用户本次对该任务的明确指定（自然语言或 `--task-agent <todo文件名>=codex|opencode`，可重复）；
2. todo 文件中的 `agent: codex` / `agent: opencode`；
3. 用户本次的全局指定（自然语言或 `--agent codex|opencode`）；
4. 队列 `README.md` 中保存的 `default_agent`；
5. 当前宿主。

`agent: inherit` 或缺少 `agent` 表示继续查找全局默认值，不是固定为生成 todo 时的宿主。用户明确要求“全部改用某 agent，包括已有指定”时，覆盖全部任务；否则全局默认不覆盖单任务选择。同一层冲突以用户最新指令为准。`inherit` 只用于 todo；全局默认必须是具体类型，无效值须指出错误。

这些 `--agent`、`--task-agent`、`--model` 和 `--reasoning-effort` 是 **skill 的输入约定**，不是原样传给 Herdr 的选项。自然语言指定与对应参数等效。按 todo 完整文件名、唯一序号或唯一标题匹配任务；匹配不到或不唯一时先澄清，不要误分配。拆分一个已指定 agent 的任务时，所有子任务继承该指定；不同 agent 的任务不要合并进同一个 todo。

## 跨阶段保存

- `make-plan` 在方案的“执行偏好”中保留用户的全局和单任务指定，并标明默认 agent 来自宿主还是用户。
- `plan-to-todo` 在 `todos/README.md` 保存解析后的全局默认值，例如 `default_agent: codex`；只有用户指定模型或推理强度时，才另外保存 `default_model` / `default_reasoning_effort`。
- 初次拆队列时，本次全局指定优先于方案保存的执行偏好，最后才跟随当前宿主。重拆已有队列时保留未被用户更改的执行偏好，并按任务含义迁移原有单任务指定，不能因改了序号而丢失或错配。
- 每个 todo 开头写 `difficulty: easy|medium|hard` 和 `agent: inherit|codex|opencode`，均为独立的元数据行。只有单任务指定才写具体 agent；不要把默认分配固化到所有 todo。
- `auto-dev` 把同一默认值与单任务指定传给规划和拆分阶段；新协调器和手动续跑都读取已保存的队列配置，不因换了宿主而丢失原选择。
- `herdr-finish-plan` 直接调用时仍支持旧队列：无保存值则跟随当前宿主。本次覆盖只影响尚未启动的任务；已在运行的任务不因收到新默认值而自动重启。

## 模型与推理强度

| difficulty | Codex 模型 | Codex reasoning effort | OpenCode 模型 |
| --- | --- | --- | --- |
| easy | `gpt-6-astra` | `high` | `bailian-token-plan/qwen3.8-flash` |
| medium | `gpt-6-astra` | `xhigh` | `bailian-token-plan/qwen3.8-flash` |
| hard | `gpt-6-astra` | `max` | `bailian-token-plan/qwen3.8-max` |

旧 todo 缺少 `difficulty` 时按 hard 处理并报告；值无效时指出错误，不静默降档。显式传入解析后的模型；Codex 还必须显式传入推理强度，避免本机配置覆盖难度映射。

保留全局 `--model <model-id>` 覆盖难度选模的能力；Codex 可用 `--reasoning-effort <effort>` 覆盖默认推理强度。它们只作用于本次全局默认 agent 类型，不跨类型套用。例如全局为 Codex 且指定模型，某任务单独用 OpenCode，该任务仍用 OpenCode 的难度映射。保存的 `default_model` / `default_reasoning_effort` 同样绑定保存的 `default_agent`；本次切换全局 agent 类型时不继承旧类型的参数。当前显式参数优先于同类型保存参数，最后才用上表。仅改模型时 Codex 推理强度仍按难度选择，并校验目标模型支持该档位；OpenCode 不接收 Codex 推理参数。

`auto-dev` 新建的协调器使用全局默认 agent，默认启动档为 Codex `gpt-6-astra` + `high` 或 OpenCode flash；用户的同类型全局模型/推理覆盖也适用。协调器的启动档不作为 todo 的难度或模型默认值，执行器仍逐任务查表。

## 检查与启动

**始终使用 auto / YOLO 模式**，适用于 `auto-dev` 协调器、所有执行任务，以及后续重启或补位的 agent。每次启动都必须显式传入对应参数，不依赖 CLI 的本机默认配置：

- OpenCode：`--auto`。
- Codex：YOLO 模式，使用 `--dangerously-bypass-approvals-and-sandbox`。

全局或单任务的 agent、模型、推理强度覆盖不改变这条启动要求。

只检查本轮实际用到的 agent kind、CLI 和模型。Codex 用本机 `codex --help` 确认参数，用可用的模型元数据或模型选择界面核对模型及 reasoning effort；OpenCode 用 `opencode models <model-id>` 核对实际选中的模型。不要求 Codex-only 队列安装 OpenCode，反之亦然。类型、模型或强度不支持时报告具体原因，不自动换 agent、换模型或降低强度。

在 Herdr 返回的可用 pane 中启动交互式 agent，原生参数放在 `--` 后。以下示例中的名称和 pane ID 需替换为本轮实际值：

```bash
# Codex easy（medium 改为 xhigh，hard 改为 max）
herdr agent start <agent-name> --kind codex --pane <pane-id> -- --dangerously-bypass-approvals-and-sandbox --model gpt-6-astra -c 'model_reasoning_effort="high"'

# OpenCode easy / medium（hard 改为 bailian-token-plan/qwen3.8-max）
herdr agent start <agent-name> --kind opencode --pane <pane-id> -- --auto --model bailian-token-plan/qwen3.8-flash
```

Codex 的 YOLO 参数会跳过审批与沙箱；`--approve-for-me` 不等同于 YOLO，不用于本流程。不要给 Codex 传 OpenCode 的 `--auto`。参数以安装的 CLI 为准，不支持要求的模式时报告，不静默退回普通交互模式。Codex 配置覆盖语法见[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

启动与汇报都使用最终解析的 agent、模型、Codex 推理强度及选择来源。`herdr-finish-plan` 的并行、隔离、复核、集成与清理规则对两种 agent 一致。

## 调用示例

```text
$auto-dev 添加登录功能；默认跟随当前 agent，数据库迁移任务用 Codex，文案任务用 OpenCode
$herdr-finish-plan add-user-auth --agent codex --task-agent 02-copy.md=opencode
```

第二个例子中，`02-copy.md` 使用 OpenCode；其他没有单任务指定的任务使用 Codex。任务难度为 medium 时，前者用 flash，后者用 `gpt-6-astra` + `xhigh`。
