---
name: auto-dev
description: 接收一个开发任务 prompt（没有则探索 repo 找改进点），用 make-plan 写方案、plan-to-todo 拆队列，再通过 Herdr 启动 herdr-finish-plan。分发默认跟随当前宿主（Codex / OpenCode），支持单任务指定 agent。用户说 /auto-dev、"auto dev"、"帮我规划这个开发任务并跑起来"、"看看这个仓库有什么可以改进的"，或希望自动拆解并执行开发需求时使用。
---

# Auto Dev

把一个开发需求 prompt 变成"方案 + 可并行执行的任务队列"并自动拉起执行。本 skill 只做编排，不改业务代码；实现交给新 session 里的 `herdr-finish-plan`。

先从 `args` 中提取分发参数，其余内容作为任务 prompt；用户也可能直接在对话里给出。两者都有时以对话内容为准，`args` 作为补充。没有开发任务 prompt（包括只给了分发参数）时 make-plan 会自动进入 repo 探索模式。

开始前读取[Agent 分发规则](../herdr-finish-plan/references/agent-routing.md)，确定全局默认 agent，并保留用户对具体任务的指定。将这些执行偏好传给下面两个规划阶段，写进计划与队列；不要在切换 session 时重新猜测默认值。

## 1. 写 plan

用 skill 工具加载 `make-plan`，按它产出 `plans/<plan-name>/plan.md`（含意图分析 / 探索模式的全部规则都在那里）。

## 2. 拆任务队列

用 skill 工具加载 `plan-to-todo`，按它把 `plans/<plan-name>/plan.md` 拆解成 `plans/<plan-name>/todos/` 队列。探索模式中标了 `roadmap` 的发现只进 plan，不进队列。

## 3. 自动开始执行

写完计划和队列后自动拉起执行，不要只留一条命令让用户手动跑。**进入执行阶段前必须先 git commit**：执行端要求干净工作区，计划文件不提交就不允许开始执行。

1. 检查工作区并提交计划文件：运行 `git status --porcelain`。
   - 若未提交内容只有刚写的 `plans/<plan-name>/` 计划文件，**先提交再往下走**：`git add plans/<plan-name> && git commit -m "chore(plans): add <plan-name> plan and todos"`；
   - 若还存在其他用户改动，停止并报告，请用户先处理，不要自行 stash、提交或丢弃那些改动。
2. 向用户报告：意图结论、plan 路径、任务队列概览（顺序 + 依赖 + 每个文件的难度、agent、模型与 Codex 推理强度）、哪些任务可并行、计划文件已提交的 commit。
3. 检查 `test "${HERDR_ENV:-}" = 1`：
   - 通过 → 继续自动启动；
   - 失败 → 执行端依赖 Herdr，无法自动启动；改为告知用户在 Herdr 管理的新 session 中运行 `$herdr-finish-plan <plan-name>`，说明默认值和单任务指定已保存到队列，然后结束。
4. 从当前 pane 分出一个同级 pane，保持在仓库根目录、不打扰用户焦点：

   ```bash
   herdr pane split --current --direction right --cwd <repo-root> --no-focus
   ```

5. 按分发规则检查并启动全局默认 agent 的协调器，始终使用 auto / YOLO 模式（名称符合 `[a-z][a-z0-9_-]{0,31}`，如 `plan-<plan-slug>`）。未显式覆盖模型/推理强度时，根据类型只执行下面对应的一条：

   ```bash
   # Codex 宿主默认用 Codex 协调器
   herdr agent start plan-<plan-slug> --kind codex --pane <pane-id> -- --dangerously-bypass-approvals-and-sandbox --model gpt-6-astra -c 'model_reasoning_effort="high"'

   # OpenCode 宿主保留原有默认
   herdr agent start plan-<plan-slug> --kind opencode --pane <pane-id> -- --auto --model bailian-token-plan/qwen3.8-flash
   ```

6. 发送执行指令（不加 `--wait`，执行可能长达数小时），要求新协调器读取队列中的执行偏好和每个 todo 的 agent 指定：

   ```bash
   herdr agent prompt plan-<plan-slug> '$herdr-finish-plan <plan-name>；读取 todos/README.md 的执行偏好与各 todo 的 agent 字段，逐任务解析 agent、模型和推理强度。'
   ```

7. 用 `herdr agent get plan-<plan-slug>` 确认 agent 进入 working 状态，然后向用户报告执行 agent 名称与所在 pane。本 skill 到此结束：不要在当前 session 等待执行完成，更不要亲自开始实现。

## 硬性规则

- 只产出 `plans/<plan-name>/` 下的文件；不修改业务代码。进入执行阶段前必须先提交计划文件（这是唯一允许的自动 commit）；用户的其他改动一律不得代为提交。
- 写 plan 必须加载 `make-plan`、拆队列必须加载 `plan-to-todo`，按各自 skill 执行，不自行发挥。
