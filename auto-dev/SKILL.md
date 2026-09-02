---
name: auto-dev
description: 接收一个开发任务 prompt，结合当前 repo 分析用户意图，写出 plans/{plan-name}/plan.md 方案，按 herdr-finish-todo 的队列格式把任务拆解到 plans/{plan-name}/todos/（每个任务标难度，决定执行时用 flash 还是 max 模型），然后自动通过 Herdr 开新 pane 用 herdr-finish-plan 开始执行。没有 prompt 时进入 repo 探索模式：系统性挖掘仓库所有可提升空间并全部列入 plan。用户说 /auto-dev、"auto dev"、"帮我规划这个开发任务"、"看看这个仓库有什么可以改进的"，或给出一个开发需求希望自动拆解并执行时使用。
---

# Auto Dev

把一个开发需求 prompt 变成"方案 + 可并行执行的任务队列"。本 skill 只做分析和规划，不改业务代码；实现交给新 session 里的 `herdr-finish-plan`。

`args` 是任务 prompt 本身；用户也可能直接在对话里给出。两者都有时以对话内容为准，`args` 作为补充。

**没有 prompt 时**（`args` 为空、对话里也只有"auto dev"之类的调用），进入 **repo 探索模式**，见第 1.5 节。

## 1. 输入与意图分析

1. 完整读取任务 prompt，判断它是什么类型的开发任务（新功能 / bug 修复 / 重构 / 基建 / 迁移…）。
2. 结合当前 repo 分析：
   - 读 `README.md`、`AGENTS.md`/`CLAUDE.md`、构建配置和目录结构，理解技术栈与模块划分；
   - 用搜索定位 prompt 涉及的代码位置，不要凭文件名猜；
   - 确定仓库级校验命令（typecheck / build / test），后面写进 plan。
3. 产出意图分析：目标、范围内 / 范围外、技术约束、风险、开放问题。
   - 会改变方案走向的关键歧义：先问用户，再写 plan；
   - 次要歧义：采用最合理的默认假设，并在 plan 中写明。

## 1.5 无 prompt：repo 探索模式

没有任务 prompt 时，目标变成"尽力挖掘这个 repo 所有可以提升的空间"，把发现全部列进 plan。

1. 先跑一遍仓库级校验命令（typecheck / build / lint / test，存在哪条跑哪条），失败的、报警告的原样记录。
2. 系统性排查，逐项过：
   - **正确性**：报错的测试、明显的 bug、`TODO`/`FIXME`/`XXX`/`HACK` 注释、已知问题文档；
   - **健壮性**：缺失的错误处理、边界条件、未校验的输入、并发 / 竞态隐患；
   - **安全**：硬编码密钥、注入风险、过时且有漏洞的依赖（依赖审计命令存在就跑）；
   - **性能**：明显的慢路径、重复计算、N+1 查询、缺失的缓存 / 索引；
   - **测试**：覆盖率薄弱的关键模块、完全没有测试的核心路径；
   - **工程 / DX**：缺失或失效的 CI、慢的构建、缺 lint / format 配置、过时的依赖大版本、缺失或过期的文档；
   - **代码质量**：重复代码、死代码、过大的文件 / 函数、混乱的模块边界。
3. 每个发现记录：位置（文件 / 模块）、问题描述、改进建议、优先级（P0→P2）、难度（easy / medium / hard）。**所有发现都要列出来，不要自行过滤掉"不重要"的**；roadmap 级的大改造也列出来，但标注 `roadmap`。
4. plan name 用 `repo-improvements`（已存在就加日期或后缀）。plan.md 的"拆解"一节就是这份完整发现清单；后续第 3 节按清单拆 todo 队列。
5. 标了 `roadmap` 的发现只进 plan 不进队列；其余全部按第 3 节规则拆成任务。

探索模式结束后直接接第 2 节（写 plan）继续，第 2 节的"意图"一节改写为探索结论摘要。

## 2. 写 plan

plan name 用短横线小写 slug（如 `add-user-auth`）。检查 `plans/` 下是否已有同名目录：已存在且内容相关就在其基础上更新，否则换一个新名字。

写 `plans/<plan-name>/plan.md`，至少包含：

- **意图**：一段话复述用户需求与分析结论；
- **目标 / 非目标**；
- **方案**：整体思路、关键设计决策、涉及模块；
- **拆解**：任务清单概览，与 `todos/` 文件一一对应，标注依赖关系；
- **校验**：仓库级校验命令与验收方式；
- **风险与假设**。

## 3. 拆任务队列（兼容 herdr-finish-todo 格式）

在 `plans/<plan-name>/todos/` 下建立任务队列。格式与 herdr-finish-todo 的 `todos/` 队列完全一致——这里只复用格式，不调用该 skill。

### todos/README.md

- 一个"优先级"表格：文件、优先级（P0→P2）、难度（easy / medium / hard）、一句话说明；
- 一个"## 文件"有序列表，明确执行顺序；
- 有依赖时逐行标注"依赖 01-xxx"。

### todo 文件

- 文件名数字前缀升序：`01-<slug>.md`、`02-<slug>.md`…
- **一个 todo 文件 = 一个独立任务 = 一个 worktree = 一个最终 commit**。粒度以"一个 agent 单轮能完成"为准：过大要拆，过碎要合。
- 文件开头必须声明难度：单独一行 `difficulty: easy | medium | hard`（执行端据此选模型，见"难度判定"）。
- 每个文件内用 `## T1 · 标题` 小节列条目，每个条目写清：
  - 要做什么（具体到函数 / 文件 / 行为）；
  - 预计修改的文件列表；
  - 验收条件（可验证的标准；需要测试就写明测试要求）；
  - 前置依赖（依赖哪个 todo 文件 / 条目，没有就写"无"）。

### 拆分原则

- 会改同一批文件的条目放进同一个 todo 文件；文件 / 模块不相交的才分开并行；
- 依赖必须显式写出（如"先有 01 的数据模型，02 才能做 API"）；
- 依赖前面实现的测试 / 验证任务，放后面的文件并标依赖；
- 每个 todo 文件都要能独立跑仓库校验，写清它自己的验证方式。

### 难度判定

为每个 todo 文件给出 `difficulty`，执行端按它选模型（easy/medium → flash，hard → max）：

- **easy**：改一两处、模式明确、照着旁边代码抄就行（改文案、加字段、补校验、调样式）。
- **medium**：单模块内多文件协作、需要理解一段现有逻辑再改、写新的测试。
- **hard**：跨模块 / 跨服务、涉及并发、状态机、数据迁移、协议或架构调整、需要设计新的抽象。

拿不准 easy 还是 medium 就写 medium；拿不准 medium 还是 hard 就写 hard——宁可升档，不要为了省模型把硬任务压给弱模型。一个文件里条目难度不一致时按最高的那条定档。

## 4. 自动开始执行

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
- plan 必须基于对仓库的实际搜索与分析，不允许凭空设计方案。
- todo 队列必须严格符合 herdr-finish-todo 的格式（README 顺序 + 数字前缀文件 + 验收条件 + 显式依赖）。
- 关键歧义先问用户；次要假设必须写进 plan。
