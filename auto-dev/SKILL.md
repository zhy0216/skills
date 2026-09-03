---
name: auto-dev
description: 接收一个开发任务 prompt（没有则探索 repo 找改进点），用 make-plan 产出 plans/{plan-name}/plan.md 方案，用 plan-to-todo 拆解到 plans/{plan-name}/todos/ 队列，然后自动通过 Herdr 开新 pane 用 herdr-finish-plan 开始执行。用户说 /auto-dev、"auto dev"、"帮我规划这个开发任务并跑起来"、"看看这个仓库有什么可以改进的"，或给出一个开发需求希望自动拆解并执行时使用。
---

# Auto Dev

把一个开发需求 prompt 变成"方案 + 可并行执行的任务队列"并自动拉起执行。本 skill 只做编排，不改业务代码；实现交给新 session 里的 `herdr-finish-plan`。

`args` 是任务 prompt 本身；用户也可能直接在对话里给出。两者都有时以对话内容为准，`args` 作为补充。`args` 为空时 make-plan 会自动进入 repo 探索模式。

## 1. 写 plan

用 skill 工具加载 `make-plan`，按它产出 `plans/<plan-name>/plan.md`（含意图分析 / 探索模式的全部规则都在那里）。

## 2. 拆任务队列

用 skill 工具加载 `plan-to-todo`，按它把 `plans/<plan-name>/plan.md` 拆解成 `plans/<plan-name>/todos/` 队列。探索模式中标了 `roadmap` 的发现只进 plan，不进队列。

## 3. 自动开始执行

写完计划和队列后自动拉起执行，不要只留一条命令让用户手动跑。**进入执行阶段前必须先 git commit**：执行端要求干净工作区，计划文件不提交就不允许开始执行。

1. 检查工作区并提交计划文件：运行 `git status --porcelain`。
   - 若未提交内容只有刚写的 `plans/<plan-name>/` 计划文件，**先提交再往下走**：`git add plans/<plan-name> && git commit -m "chore(plans): add <plan-name> plan and todos"`；
   - 若还存在其他用户改动，停止并报告，请用户先处理，不要自行 stash、提交或丢弃那些改动。
2. 向用户报告：意图结论、plan 路径、任务队列概览（顺序 + 依赖 + 每个文件的难度与将用的模型）、哪些任务可并行、计划文件已提交的 commit。
3. 检查 `test "${HERDR_ENV:-}" = 1`：
   - 通过 → 继续自动启动；
   - 失败 → 执行端依赖 Herdr，无法自动启动；改为告知用户在 Herdr 管理的新 session 中运行 `$herdr-finish-plan <plan-name>`，然后结束。
4. 从当前 pane 分出一个同级 pane，保持在仓库根目录、不打扰用户焦点：

   ```bash
   herdr pane split --current --direction right --cwd <repo-root> --no-focus
   ```

5. 在新 pane 启动 auto 模式、使用 flash 模型的 OpenCode（名称符合 `[a-z][a-z0-9_-]{0,31}`，如 `plan-<plan-slug>`）：

   ```bash
   herdr agent start plan-<plan-slug> --kind opencode --pane <pane-id> -- --auto --model bailian-token-plan/qwen3.8-flash
   ```

6. 发送执行指令（不加 `--wait`，执行可能长达数小时）：

   ```bash
   herdr agent prompt plan-<plan-slug> '$herdr-finish-plan <plan-name>'
   ```

7. 用 `herdr agent get plan-<plan-slug>` 确认 agent 进入 working 状态，然后向用户报告执行 agent 名称与所在 pane。本 skill 到此结束：不要在当前 session 等待执行完成，更不要亲自开始实现。

## 硬性规则

- 只产出 `plans/<plan-name>/` 下的文件；不修改业务代码。进入执行阶段前必须先提交计划文件（这是唯一允许的自动 commit）；用户的其他改动一律不得代为提交。
- 写 plan 必须加载 `make-plan`、拆队列必须加载 `plan-to-todo`，按各自 skill 执行，不自行发挥。
