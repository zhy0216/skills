---
name: plan-to-todo
description: 把已有方案（plans/{plan-name}/plan.md 或对话里的任务清单）拆成 todos/ 队列：README 优先级与执行顺序、数字前缀文件、难度、agent 选择、验收条件与依赖。默认跟随 Codex / OpenCode 宿主，保留用户的单任务指定，供 herdr-finish-plan 按难度分发。用户说 /plan-to-todo、"把方案拆成 todos"、"拆任务队列"，或需要把方案拆成可并行任务时使用。
---

# Plan To TODO

把一份方案变成"可并行执行的任务队列"。本 skill 只写 `todos/` 队列文件，不改业务代码，也不负责执行。沿用 herdr-finish-todo 的 README 顺序、数字前缀和验收条件格式，增加 herdr-finish-plan 使用的难度与 agent 元数据；不调用执行 skill。

`args` 应给出方案位置（如 `plans/<plan-name>/plan.md` 或 plan name）；用户也可能直接在对话里给出方案内容，以对话内容为准。

## 1. 读取方案

1. 完整读取方案。`args` 只给 plan name 时，找 `plans/<plan-name>/plan.md`。
2. 方案缺少可直接落地的任务清单（只有高层思路、没有具体拆解）时，先结合 repo 搜索定位涉及的模块 / 文件，补足信息再拆；不要凭空拆。
3. 标了 `roadmap`、范围外或"暂不做"的条目不进队列；其余全部拆成任务。
4. 读取[Agent 分发规则](../herdr-finish-plan/references/agent-routing.md)，合并本次用户指令、方案执行偏好与当前宿主默认值；将用户指定的任务映射到实际 todo。读取参考文档不触发执行。

## 2. 建立任务队列

队列写在方案同级的 `todos/` 下（如 `plans/<plan-name>/todos/`）；方案不属于 `plans/` 体系时写仓库根的 `todos/`。

### todos/README.md

- 一个"优先级"表格：文件、优先级（P0→P2）、难度（easy / medium / hard）、agent、模型 / Codex 推理强度、一句话说明；
- 一个"## 文件"有序列表，明确执行顺序；
- 有依赖时逐行标注"依赖 01-xxx"；
- 一个"执行偏好"区块，保存 `default_agent: codex` 或 `default_agent: opencode`；仅在用户显式指定时保存 `default_model` / `default_reasoning_effort`。表格显示按分发规则解析后的实际选择，标明单任务指定或继承默认。

### todo 文件

- 文件名数字前缀升序：`01-<slug>.md`、`02-<slug>.md`…
- **一个 todo 文件 = 一个独立任务 = 一个 worktree = 一个最终 commit**。粒度以"一个 agent 单轮能完成"为准：过大要拆，过碎要合。
- 文件开头必须声明难度：单独一行 `difficulty: easy | medium | hard`（执行端据此选模型，见"难度判定"）。下一行写 `agent: inherit | codex | opencode`，实际只填一个值；没有单任务指定就写 `inherit`，不要把全局默认固化进每个任务。
- 每个文件内用 `## T1 · 标题` 小节列条目，每个条目写清：
  - 要做什么（具体到函数 / 文件 / 行为）；
  - 预计修改的文件列表；
  - 验收条件（可验证的标准；需要测试就写明测试要求）；
  - 前置依赖（依赖哪个 todo 文件 / 条目，没有就写"无"）。

### 拆分原则

- 会改同一批文件且 agent 指定相容的条目放进同一个 todo 文件；文件 / 模块不相交的才分开并行；
- 依赖必须显式写出（如"先有 01 的数据模型，02 才能做 API"）；
- 依赖前面实现的测试 / 验证任务，放后面的文件并标依赖；
- 每个 todo 文件都要能独立跑仓库校验，写清它自己的验证方式。
- 拆分用户指定 agent 的任务时，子任务继承指定；不同 agent 的任务保持分开，有文件重叠时用依赖串行化。

### 难度判定

为每个 todo 文件给出 `difficulty`，执行端先解析 agent，再按共享分发规则选模型和推理强度：

- **easy**：改一两处、模式明确、照着旁边代码抄就行（改文案、加字段、补校验、调样式）。
- **medium**：单模块内多文件协作、需要理解一段现有逻辑再改、写新的测试。
- **hard**：跨模块 / 跨服务、涉及并发、状态机、数据迁移、协议或架构调整、需要设计新的抽象。

拿不准 easy 还是 medium 就写 medium；拿不准 medium 还是 hard 就写 hard——宁可升档，不要为了省模型把硬任务压给弱模型。一个文件里条目难度不一致时按最高的那条定档。

## 3. 收尾

向用户报告：队列位置、任务顺序、依赖关系、每个文件的难度、最终 agent、模型与 Codex 推理强度、哪些任务可并行。共享分发规则中的难度映射是唯一来源。

## 硬性规则

- 只写 `todos/` 队列文件；不修改业务代码，不启动执行。
- 拆解必须基于方案与仓库的实际情况，不允许凭空编造文件名、模块名。
- 队列必须保留 README 顺序 + 数字前缀文件 + 验收条件 + 显式依赖。
- 每个 todo 文件必须声明 `difficulty` 和 `agent`；README 必须保存 `default_agent`，用户的单任务指定不得丢失。
