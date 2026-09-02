---
name: herdr-finish-todo
description: 使用 Herdr 为 todo 队列创建独立 Git worktree，并在最多 5 个并行任务中启动 auto 模式的 OpenCode（默认 bailian-token-plan/qwen3.8-flash，可通过调用参数指定模型）；每个任务完成后先 rebase 原分支并解决冲突，再合并、清理 worktree、补充下一项。仅在用户显式调用 $herdr-finish-todo、输入 /herdr-finish-todo，或明确要求用 Herdr 并行清完 todos 时使用。
---

# Herdr Finish TODO

把 `todos/` 当成有序任务队列。默认一个 todo 文件对应一个独立任务、Git 分支、Herdr workspace 和 worktree；不要把同一个 todo 文件拆给多个 worktree，除非用户明确要求且修改范围完全不重叠。

协调器始终留在调用 skill 时的原 checkout，独占原分支的合并操作。实现工作由 Herdr 启动的 OpenCode 完成。最多同时保留 5 个未完成任务，使用滑动窗口：一个任务完成合并并清理后，立即分配下一项，不等待整批结束。

显式调用本 skill 表示用户授权：在当前仓库内创建和删除本轮专用 worktree/本地任务分支、启动带 `--auto` 的 OpenCode、修改 todo 涉及的文件、运行仓库校验、创建本地 commit、rebase 和合并回原分支。不要 push、创建 PR、修改远端状态或操作本轮之外的 workspace/worktree，除非用户另行要求。

`args` 可选，用于按文件名、序号、优先级或条目 id 缩小范围；过滤后仍保留原队列顺序。也可通过 `args` 指定模型（如 `--model <provider/model>` 或直接给出模型 id）；未指定时使用默认的 `bailian-token-plan/qwen3.8-flash`。

## 1. 前置检查

1. 验证当前代理处于 Herdr 管理的 pane：

   ```bash
   test "${HERDR_ENV:-}" = 1
   ```

   失败时停止；不要从 Herdr 外部控制用户的会话。

2. 以已安装 CLI 为准，先读取只读帮助：

   ```bash
   herdr --help
   herdr agent
   herdr worktree
   ```

   确认 `opencode` agent kind 可用。不要用裸 `herdr` 做发现，因为它会启动或附加 TUI。

3. 确认 `opencode` 可执行，并确认模型存在：

   ```bash
   command -v opencode
   opencode models qwen3.8-flash
   ```

   默认必须使用 `bailian-token-plan/qwen3.8-flash`。若用户在调用时显式指定了模型，则使用用户指定的模型，并同样先用 `opencode models` 确认其存在。即使目标模型当前是默认模型，也要显式传入；不可静默改用其他模型。

4. 解析仓库根目录，确认当前处于有名字的原分支而非 detached HEAD，记录原分支名和起始 HEAD。运行 `git status --porcelain`；原 checkout 必须干净。存在用户改动时停止，请用户决定如何处理，不要自行 stash、提交或丢弃。

5. 确认 `todos/README.md` 存在并完整读取。再读取适用的 `AGENTS.md`、`CLAUDE.md`、README 和构建配置，确定仓库级校验命令。至少要有一条可发现编译或类型错误的命令；存在测试时一并执行。无法可靠确定时询问用户，不要猜测。

6. 读取现有 `git worktree list`、Herdr workspace 和 agent 状态，只记录本轮创建的资源。不要清理或复用来源不明的 workspace、pane、worktree 或分支。

## 2. 建立任务队列

完整读取 `todos/README.md`，优先使用其中明确的优先级和顺序；没有明确顺序时按文件名数字前缀升序。跳过 `todos/README.md` 和 `todos/done/`。

对每个候选 todo 文件完整读取条目，记录：

- 验收条件、预计修改文件和校验要求；
- 显式或推断的前置依赖；
- 与其他 todo 的文件或模块重叠；
- roadmap、blocked 或需要用户决策的范围。

只并行分配彼此独立的任务。存在依赖、同文件修改、迁移顺序或紧密耦合模块时，后续任务必须等待。按队列顺序选择当前可运行项，开工前向用户报告任务顺序、依赖和首批分配。

## 3. 启动最多 5 个 OpenCode 任务

为每个任务生成唯一、可追踪的短名称。Herdr agent 名称必须符合 `[a-z][a-z0-9_-]{0,31}`；任务分支建议使用 `herdr/todo-<序号>-<slug>`。若名称或分支已存在，生成新名称，不要覆盖。

从原分支的当前最新提交创建 Herdr worktree，保持用户焦点不变：

```bash
herdr worktree create --cwd <repo-root> --branch <task-branch> --base <base-branch> --label <todo-label> --no-focus
```

从 JSON 响应中读取实际的 workspace ID、worktree 路径和 root pane ID，不要猜测。保存以下映射，直到任务清理完毕：todo 文件、任务分支、workspace ID、pane ID、agent 名称、worktree 路径和状态。

在 worktree 的 root pane 启动 OpenCode：

```bash
herdr agent start <agent-name> --kind opencode --pane <pane-id> -- --auto --model bailian-token-plan/qwen3.8-flash
```

若用户调用时指定了其他模型，将 `--model` 替换为该模型。

这里的“fork”是为每个任务创建独立 Git worktree 和独立 OpenCode 实例；不要使用 `opencode --fork`，那是会话续接功能，不是任务分支隔离。

向 agent 发送任务提示时先不要使用 `--wait`，以便填满并行窗口。提示必须包含 todo 原文、验收条件、允许修改的范围、仓库约束和校验命令，并明确要求：

```text
你位于 Herdr 为本任务创建的独立 Git worktree，只处理指定 todo 文件。
完整读取 todo 原文、仓库说明和相关源码；实现全部验收条件，不顺手重构、不升级依赖、不修改无关文件。
只在当前任务分支执行 git 写操作；禁止切换、修改或合并原分支，禁止 push、创建 PR、stash、删除 worktree 或操作其他任务分支。
运行与改动相关的校验。全部完成时更新 todo 状态：只有所有条目完成才可归档到 todos/done/ 并更新 todos/README.md。
创建且只保留一个本地任务 commit，遵循仓库提交风格。此阶段不要 rebase 或 merge；协调器会在集成阶段另行通知。
结束时报告：commit、修改文件、逐条验收证据、校验命令与结果、剩余风险或 blocker，并保持 worktree 干净。
```

同时处于 starting、working、done-but-not-integrated、reviewing 或 rebasing 状态的任务总数不得超过 5。资源不足或可运行任务不足时可以少于 5，不得为了凑数启动有依赖或明显冲突的任务。

## 4. 监控并复核完成结果

所有任务启动后用 `herdr agent list/get/read/wait` 监控。`done` 或在已观察到 working 生命周期之后回到 `idle` 才可能表示完成；`unknown` 不代表完成。读取结果优先使用：

```bash
herdr agent read <agent-name> --source recent-unwrapped --lines 160
```

对仍处于 `working`/Thinking 的 OpenCode 采用 **15 分钟监控节奏**：完成一次批量状态检查后，若没有 `done`、`idle` 或 `blocked` 等可操作状态，选择一个正在工作的 agent 做最长 15 分钟的状态感知等待：

```bash
herdr agent wait <agent-name> --timeout 900000
```

wait 若因 agent settle 而提前返回，立即处理并同时刷新所有任务；若返回 `timeout`，这只是下一个 15 分钟检查点，不是失败、停滞或需要中断的证据。在该检查点用一次 `herdr agent list` 批量刷新，只对状态变化、完成或 blocked 的 agent 进一步 `get/read`，然后再进入下一个 15 分钟等待。不要用 15 秒或其他短超时循环高频轮询。

OpenCode 在复杂任务上可能长时间保持 Thinking。不得仅因 Thinking 持续时间长、一个或多个 15 分钟周期内状态未变、画面相同或 worktree 暂无改动，就发送 `esc`/`ctrl+c`、重启 agent 或改写任务。只有出现明确的错误、进程退出、需要交互的 `blocked` 状态，或用户明确要求停止时，才停止正常等待；若怀疑真正死循环，先收集 `get/read` 和 worktree 证据并向用户报告，不要擅自中断。

单个任务从启动开始累计超过 **2 小时**仍未完成或无可操作状态，视为异常：发送 `esc` 停止该 agent，按未完成任务记录 blocker，不再补位；同时停止整个 Workflow——中断剩余工作中的 agent（`ctrl+c`）、放弃后续排队任务，向用户报告各任务状态、已完成项与残留资源，等待用户决定是否继续。

若 agent 为 `blocked`，先读取界面和原因。不要盲目发送按键或代替用户回答范围、权限和产品决策；`--auto` 只自动批准 OpenCode 未显式拒绝的权限。

agent 自报完成后，协调器必须在其 worktree 中独立检查：

- `git status --short` 为空且没有进行中的 rebase；
- 相对原分支确有任务 commit，且最终只保留一个任务 commit；
- diff 仅覆盖该 todo 的合理范围；
- 每条验收条件有代码或测试证据；
- todo 只有在所有条目完成时才归档，README 没有误标；
- `git diff --check` 和局部校验通过。

有遗漏时把具体问题发回原 agent 修复并 amend 当前任务 commit。证据不足时不得进入集成。真正 blocked 的任务不得标为完成，也不得强制清理含未保存工作的 worktree；记录 blocker，并继续处理仍有空闲槽位且无依赖的任务。

## 5. 串行 rebase 与合并

实现可以并行，但 rebase → 冲突处理 → 仓库级校验 → 合并必须持有单一“集成锁”，一次只处理一个任务。其他 OpenCode 可继续实现，但不能同时推进原分支。

对待集成任务执行：

1. 再次确认原 checkout 干净，并记录原分支当前 HEAD。在整个集成阶段不要合并其他任务。
2. 提示同一个 OpenCode agent 在自己的 worktree 中执行：

   ```text
   进入集成阶段。将当前任务分支 rebase 到原分支 <base-branch> 的最新提交。
   必须亲自解决全部冲突，保留原分支已合入任务的正确行为，同时保留本 todo 的验收结果。
   完成 rebase 后重新运行相关校验；若需要修复，只 amend 当前任务 commit。
   不要 merge、push、切换原 checkout 或清理 worktree。返回新 HEAD、冲突处理摘要、git status 和校验结果。
   ```

3. 等待 agent settle 后，检查 rebase 已结束、worktree 干净、原分支是任务分支的祖先、任务仍只有一个 commit，并重新审查 rebase 后的完整 diff。
4. 协调器在该 worktree 中亲自运行既定仓库级校验。agent 的自报结果不能替代本步骤。失败时发回 agent 修复、amend，再从复核开始。
5. 回到原 checkout，使用快进合并：

   ```bash
   git merge --ff-only <task-branch>
   ```

   若失败，说明原分支在集成锁期间发生了变化或 rebase 不完整；不要强行 merge。重新 rebase、解决冲突并复验。
6. 验证原分支 HEAD 等于任务分支 HEAD、todo 状态正确、`git status --short` 为空。至此代码已合入，但任务只有清理后才算真正完成。

不得用 merge commit 绕过 rebase，不得 force-push、reset 原分支或覆盖冲突。

## 6. 清理并立即补位

只清理本轮创建且已经成功合并的资源。优先让空闲 OpenCode 正常退出；随后使用记录的 workspace ID：

```bash
herdr worktree remove --workspace <workspace-id>
git branch -d <task-branch>
```

若 OpenCode 仍占用 workspace，先用 `herdr agent send-keys <agent-name> ctrl+c` 并确认退出，再重试。仅当分支已经合并、worktree 干净、路径和 workspace ID 均与本轮记录完全一致时，才可考虑 `herdr worktree remove --force`；否则停止并报告，不得删除可能未保存的工作。

清理成功后，把任务标为完成并立刻从队列中选择下一个依赖已满足的任务，创建新 worktree 和 OpenCode agent，使并行窗口回到最多 5 个。不要等待其他四个任务完成后才补位。

## 7. 收尾

队列处理结束后报告：

- 本轮合入原分支的 commit 与对应 todo；
- 已归档到 `todos/done/` 的文件；
- 每个任务的仓库级校验证据；
- blocked、deferred 或未完成项及原因；
- 尚保留的 Herdr workspace、worktree 或任务分支及保留原因；
- 原分支最终 `git status --short`。

不要 push 或创建 PR，除非用户明确要求。

## 硬性规则

- 最多 5 个并行任务，使用完成即补位的滑动窗口。
- 默认一个 todo 文件对应一个 worktree 和一个最终 commit。
- OpenCode 必须通过 Herdr 启动，并显式使用 `--auto --model <模型>`；模型默认为 `bailian-token-plan/qwen3.8-flash`，用户显式指定时使用指定模型。
- OpenCode 处于 `working`/Thinking 时默认每 15 分钟批量检查一次；短超时或长时间 Thinking 都不是中断依据。
- 单个任务运行超过 2 小时未完成即停掉该 agent 并停止整个 Workflow，报 blocker 后等待用户决定。
- OpenCode 只写自己的任务分支；协调器独占原分支和最终合并。
- 每个任务必须先 rebase 原分支并解决冲突，再通过仓库级校验和 `git merge --ff-only`。
- 合并成功并清理本轮 worktree 后，任务才算完成。
- 只清理本轮创建且已安全合并的资源；不隐瞒冲突、失败、blocker 或残留资源。
