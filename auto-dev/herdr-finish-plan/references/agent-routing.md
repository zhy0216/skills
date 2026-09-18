# Agent 分发规则

`auto-dev`、`make-plan`、`plan-to-todo`、`herdr-finish-plan` 和 `herdr-finish-todo` 共用本规则。这里只定义选择、传递和启动参数；读取本文件不代表调用执行 skill。

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

这些 `--agent`、`--task-agent` 和 `--model` 是 **skill 的输入约定**，不是原样传给 Herdr 的选项。自然语言指定与对应参数等效。按 todo 完整文件名、唯一序号或唯一标题匹配任务；匹配不到或不唯一时先澄清，不要误分配。拆分一个已指定 agent 的任务时，所有子任务继承该指定；不同 agent 的任务不要合并进同一个 todo。

## 跨阶段保存

- `make-plan` 在方案的“执行偏好”中保留用户的全局和单任务指定，并标明默认 agent 来自宿主还是用户。
- `plan-to-todo` 在 `todos/README.md` 保存解析后的全局默认值，例如 `default_agent: codex`；只有用户指定白名单内模型时，才另外保存 `default_model`。
- 初次拆队列时，本次全局指定优先于方案保存的执行偏好，最后才跟随当前宿主。重拆已有队列时保留未被用户更改的执行偏好，并按任务含义迁移原有单任务指定，不能因改了序号而丢失或错配。
- 每个 todo 开头写 `difficulty: easy|medium|hard|extreme` 和 `agent: inherit|codex|opencode`，均为独立的元数据行。只有单任务指定才写具体 agent；不要把默认分配固化到所有 todo。
- `auto-dev` 把同一默认值与单任务指定传给规划和拆分阶段；新协调器和手动续跑都读取已保存的队列配置，不因换了宿主而丢失原选择。
- `herdr-finish-plan` / `herdr-finish-todo` 直接调用时仍支持旧队列：无保存值则跟随当前宿主。本次覆盖只影响尚未启动的任务；已在运行的任务不因收到新默认值而自动重启。

## 模型白名单与推理强度

只能从下表白名单中选模型，白名单外一律拒绝并报错，不静默替换：

| Agent | 模型 | 用途 |
| --- | --- | --- |
| Codex | `gpt-6-astra` | Codex 唯一模型，reasoning effort 固定 `max` |
| OpenCode | `alibaba-token-plan-cn/qwen3.8-max` | hard / extreme 默认 |
| OpenCode | `alibaba-token-plan-cn/glm-5.3` | hard 档能力，用户显式指定时使用（不参与夜间折扣） |
| OpenCode | `alibaba-token-plan-cn/deepseek-v4.1-flash` | easy / medium 默认 |
| OpenCode | `opencode-go/deepseek-v4.1-flash` | deepseek 备用通道；仅在用户明确指定或 alibaba-token-plan-cn 渠道不可用且用户同意时使用 |

思考深度全部为 max，不随难度变化：Codex 始终显式传 `-c 'model_reasoning_effort="max"'`，避免本机配置覆盖；OpenCode 模型本身不带推理强度参数。难度只决定 OpenCode 用哪个白名单模型。

`gpt-6-astra`、`qwen3.8-max`、`glm-5.3` 都能做 hard 问题；hard 任务一般会显式指定 agent 和模型，未指定时按上表默认（Codex 用 `gpt-6-astra`，OpenCode 用 `qwen3.8-max`）。

**夜间折扣（北京时间 22:00 - 次日 08:00）**：`alibaba-token-plan-cn` 的 `qwen3.8-max` 和 `deepseek-v4.1-flash` 五折，`glm-5.3` 不参与。所有难度默认模型都已是折扣模型，选模不随时段变化；本条仅作为成本背景（例如用户想显式指定 glm-5.3 时可提示夜间 qwen3.8-max 更划算）。

extreme 与 hard 同档：extreme 只标记风险与"先拆小 / 先出设计文档"的处理要求，不改变启动参数。

旧 todo 缺少 `difficulty` 时按 hard 处理并报告；值无效时指出错误，不静默降档。旧的 `bailian-token-plan/` 前缀已失效，一律使用 `alibaba-token-plan-cn/`。

保留全局 `--model <model-id>` 覆盖难度选模的能力，但取值必须在该 agent 类型的白名单内；白名单外的值直接报错。`--reasoning-effort` 已废弃（思考深度固定 max），传入时忽略并提示。模型覆盖只作用于本次全局默认 agent 类型，不跨类型套用；某任务单独换 agent 类型时，该任务仍用对应类型的难度映射。保存的 `default_model` 同样绑定保存的 `default_agent`，且必须是白名单值；本次切换全局 agent 类型时不继承旧类型的模型。当前显式参数优先于同类型保存参数，最后才用上表。

`auto-dev` 新建的协调器使用全局默认 agent，启动档为 Codex `gpt-6-astra` + `max` 或 OpenCode `alibaba-token-plan-cn/qwen3.8-max`；用户的同类型全局白名单模型覆盖也适用。协调器的启动档不作为 todo 的模型默认值，执行器仍逐任务查表。

## 检查与启动

**始终使用 auto / YOLO 模式**，适用于 `auto-dev` 协调器、所有执行任务，以及后续重启或补位的 agent。每次启动都必须显式传入对应参数，不依赖 CLI 的本机默认配置：

- OpenCode：`--auto`。
- Codex：YOLO 模式，使用 `--dangerously-bypass-approvals-and-sandbox`。

全局或单任务的 agent、模型、推理强度覆盖不改变这条启动要求。

只检查本轮实际用到的 agent kind、CLI 和模型。Codex 用本机 `codex --help` 确认参数，用可用的模型元数据或模型选择界面核对模型及 reasoning effort 为 `max`；OpenCode 用 `opencode models <model-id>` 核对模型确实在白名单内可用。不要求 Codex-only 队列安装 OpenCode，反之亦然。类型或模型不支持、模型不在白名单时报告具体原因，不自动换 agent、换模型或降级。

在 Herdr 返回的可用 pane 中启动交互式 agent，原生参数放在 `--` 后。以下示例中的名称和 pane ID 需替换为本轮实际值：

```bash
# Codex（effort 固定 max）
herdr agent start <agent-name> --kind codex --pane <pane-id> -- --dangerously-bypass-approvals-and-sandbox --model gpt-6-astra -c 'model_reasoning_effort="max"'

# OpenCode easy / medium（hard / extreme 改为 alibaba-token-plan-cn/qwen3.8-max）
herdr agent start <agent-name> --kind opencode --pane <pane-id> -- --auto --model alibaba-token-plan-cn/deepseek-v4.1-flash
```

Codex 的 YOLO 参数会跳过审批与沙箱；`--approve-for-me` 不等同于 YOLO，不用于本流程。不要给 Codex 传 OpenCode 的 `--auto`。参数以安装的 CLI 为准，不支持要求的模式时报告，不静默退回普通交互模式。Codex 配置覆盖语法见[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

启动与汇报都使用最终解析的 agent、模型、Codex 推理强度及选择来源。`herdr-finish-plan` 的并行、隔离、复核、集成与清理规则对两种 agent 一致。

## 调用示例

```text
$auto-dev 添加登录功能；默认跟随当前 agent，数据库迁移任务用 Codex，文案任务用 OpenCode
$herdr-finish-plan add-user-auth --agent codex --task-agent 02-copy.md=opencode
```

第二个例子中，`02-copy.md` 使用 OpenCode；其他没有单任务指定的任务使用 Codex。任务难度为 medium 时，前者用 `alibaba-token-plan-cn/deepseek-v4.1-flash`，后者用 `gpt-6-astra` + `max`。
