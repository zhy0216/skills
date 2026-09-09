---
name: linear-auto-dev
description: 实现复杂的 Linear issue：将分析方案保存为关联该 issue 的 Linear Document，将有依赖和验收条件的任务队列维护在 issue description，再持续执行并更新进度。适用于 finish-linear-todo 判定的复杂任务，或用户要求以 Linear 承载自动开发计划。
---

# Linear Auto Dev

沿用 `auto-dev` 的“分析 → plan → todos → 执行”流程，规划和进度的事实来源是同一个 Linear issue。plan 是通过 `issueId` 直接关联的 Document；todos 是原 description 内的 Markdown checklist。业务仓库无需新增 `plans/` 目录，也不依赖 Herdr。

watcher 的 context 含 `stage` 时，先读取 [角色与阶段执行规则](../references/stages.md)，只完成当前阶段：`plan`、`todos` 使用 planner，`implement` 使用 executor；后续验证与合并也归 executor。下一阶段由 orchestrator 决策，再由 watcher 按角色配置启动。下面“立即执行”“交回验证”描述完整流程模式，不要求当前阶段越过自己的范围。Codex 和 OpenCode 都遵循同样的 Linear 产物与交接约定。

从 [../finish-linear-todo/SKILL.md](../finish-linear-todo/SKILL.md) 进入时，继续使用已创建的 issue worktree、started 状态和执行上下文。用户直接调用本 skill 时，先按 finish-linear-todo 的第 1 阶段建立上下文、worktree 和 started 状态，然后回到这里，不重复做复杂度判断。使用共用助手 [../scripts/linear-issue.ts](../scripts/linear-issue.ts)，按 [../references/linear-cli.md](../references/linear-cli.md) 读写 Linear。

## 1. 分析并发布 plan

读取 issue 的原始目标、验收、依赖、comments、现有 Document，以及仓库约束和相关实现。将需求转换成可验收结果；补齐实现所需的普通假设，有依据地选择实现方案。重大缺失信息应形成具体阻塞，不能编造产品要求。

plan 保持与复杂度相称，涵盖：目标与范围、当前代码证据、选定方案和有意义的权衡、受影响模块/数据/接口、实施步骤与依赖、验证策略及具体阻塞。不要为了填模板加入无关工作。

在 `runDir/plan.md` 准备内容，运行：

```bash
bun "$helper" plan "$issueId" --file "$planFile"
```

助手会查找或创建 `${identifier} — Implementation plan`，新建时用 `DocumentCreateInput.issueId` 直接关联 issue，更新时复用同一 Document。保存返回的 document ID/URL，并从 issue.documents 读回。发布成功后才进入下一步；草稿尚未发布时不能声称 Linear 中已有 plan。

## 2. 把任务队列写入 description

按可单独验证的实现步骤拆分，每个任务使用稳定编号（如 T01）、checkbox、范围、验收条件、依赖和复杂度。执行顺序服从依赖；说明确实可独立工作的子任务，不为凑并行度拆分紧耦合代码。

任务文件示例：

```markdown
- [ ] T01 — 补齐输入校验（中等；依赖：无）
  范围：请求解析与错误响应。验收：缺失必填字段得到约定的错误码与消息。
- [ ] T02 — 接入调用入口（中等；依赖：T01）
  范围：实际调用入口。验收：完整输入可完成操作，错误输入可看到对应反馈。
- [ ] T03 — 验证整体用户流程（中等；依赖：T02）
  验收：正常路径与关键错误路径均有运行证据。
```

在 `runDir/tasks.md` 准备 checklist，运行：

```bash
bun "$helper" todos "$issueId" --file "$tasksFile" --plan-url "$planUrl"
```

助手只替换 `## Implementation tasks (linear-auto-dev)` 节，其余原始需求、验收、用户补充都保留。每次更新前先重新读取最新 description，把用户对任务的有效修改整合到本次内容；不要用旧快照覆盖已变化的需求。助手会在观察到并发编辑时拒绝本次写入；重新读取后再处理。任务小节内用 `###` 或更深标题，避免截断管理范围。

## 3. 立即执行并持续同步

plan 和任务队列发布后，在当前 issue worktree 立即开始实现，不停在规划阶段，也不调用原 auto-dev 去生成本地 plans 或另开无人等待的协调器。遵循依赖推进任务，完成实现与该任务验收后才勾选；同步 Linear description。实现偏离 plan 时，先更新同一 Document 和受影响的任务说明，再继续。

默认按依赖顺序执行。当前环境支持 agent 委派、且存在可独立实现的工作时，可以并行分配这些子任务；每个写代码的子 agent 使用独立子 worktree，基于当前 issue 分支。执行偏好继承 context 的 `roleAgents.executor`，包括 agent、model、reasoningEffort 和 extraArgs；没有角色配置时沿用用户明确的执行偏好。提供明确输入、变更范围、依赖、验收和交付要求。子 agent 只提交并报告自己的实现与验证；executor 负责读回结果、按依赖合入 issue 分支、解决冲突、更新 Document/description。不要让子 agent 竞争修改 Linear 进度、issue 状态或原主分支。必须等所有已派发任务收尾后才能进行最终验证。

出现新前置依赖时修改任务队列；出现阻塞时记录已完成项、具体原因及解除条件，保留未完成 checkbox。修正 bug 后按影响范围重验，不用“子任务已提交”替代整体用户结果验证。

## 4. 交回验证与合并

所有必要实现步骤完成并有证据后，回到 finish-linear-todo 的第 3、4 阶段：验证最终集成代码、把 validation 实际产物发到 issue comments、合入最初记录的 main/master、核对结果并改 Done。任务 checkbox 全部完成并不表示主分支已合并；最终结果以这几项操作的真实读回为准。
