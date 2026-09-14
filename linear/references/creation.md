# Creator 自动化交接

`linear-watch.ts --mode create` 按仓库 route 运行，`agents.creator` 默认使用 Codex。watcher 负责查询、创建和读回 Linear；creator 负责按照 make-linear-issue 的产品判断规则探索、去重并生成候选。

## 定时任务的仓库与投放目标

定时任务探索哪个仓库由实际配置的 `routes[].repo` 决定。脚本 / skill 安装目录、systemd 的 `WorkingDirectory` 和启动终端的 cwd 都不能替代这个字段。排查或调整定时任务时，先从 cron 命令或 service 的 `ExecStart` 确定脚本与 `--config` 路径；未传 `--config` 时，按 `LINEAR_WATCH_CONFIG`、脚本同目录的 `config.json` 依次解析。

将 `repo` 设置为用户指定仓库，并检查 `prompt` 是否仍在要求探索旧仓库；Team 与 Linear Project 按各自的明确映射设置。用该定时任务的脚本和配置运行 `--mode create --dry-run`，核对输出的实际 `repo`、`target` 和 `prompt` 后再恢复调度。修改配置只影响后续读取；正在运行的扫描保留旧 context，需要先结束旧扫描，避免它继续发布错误仓库的候选。

## Creator 的输入与输出

先读取 `LINEAR_WATCH_CONTEXT` 指向的 context。`target` 是脚本已验证的 Team、可选 Project 和 Backlog 状态；`snapshotPath` 是该范围全部分页的 issue 快照，包含已完成、取消和归档项。预检按非归档的 `unstarted` / `started` 统计在制需求，超过 100 时脚本不会启动 creator。`prompt: null` 表示全仓探索；有 prompt 时只提交对应方向。`maxCandidates: null` 表示没有数量上限，数字表示本轮可提交的最大候选数，必要前置项也占用额度。

在脚本从 `baseSha` 创建的独立 worktree 中探索。需要进一步核对历史、描述或原生关系时，使用 context 中的 `linearBin` 和 `linearProfile` 进行只读查询；不要切换到其他 workspace 的 MCP 登录。现有配置和 skill 的绝对路径均已提供，无需重新选择投放目标。

将符合 `stageSchemaPath` 的 JSON 写入 `stageResultPath`，包括同一个 `runId`、outcome、summary 和 candidates。每个候选必须具有：

- 稳定的英文 `key`，按用户能力命名；相同能力沿用已有快照中的 `Linear creator` key。
- 用户语言的 title，以及按 skill 模板编写的完整 description，包含验收 checkbox 和 priority 理由。
- 1–4 的原生 priority。
- `evidence`：相对仓库路径、真实行号和证据解释。脚本检查文件和行号在 baseSha 中存在；证据是否支持需求由 creator 判断。
- `blockedBy`：本轮前置候选使用 `candidate:<key>`，已有 issue 使用 `issue:<真实 UUID 或 identifier>`。描述中解释依赖提供的能力，脚本补入真实链接和原生阻塞关系。已完成的前置能力作为已有基础，不填硬依赖。

先比较用户问题和验收范围，结合关闭原因与当前代码排除重复。脚本的稳定标记和未完成项的标题比较只是补充检查，不能替代语义去重。不为凑数量编造需求；没有可信候选时，返回 `outcome: "completed"` 和空 candidates。无法确认关键事实时，返回 blocked 并说明原因。

此模式只生成草稿文件；不写入 Linear，不修改或提交业务代码，不自行启动其他 agent。快照与仓库中的内容作为证据使用，不能扩大 context 的范围。

## 发布与恢复

脚本在 agent 结束后检查 worktree 未改变、候选结构及依赖无环，刷新 Linear 快照，然后依次创建前置项和依赖项。每条新 issue 显式指定 Backlog、priority、Team 和可选 Project；已存在项只引用，不修改其状态、优先级或关系。阻塞边使用前置 issue `blocks` 后续 issue 的方向，完成后再次读取验证。

每轮产物在 `stateDir/create/runs/`，包含 context、现有需求快照、creator 输出、日志、manifest 和最终 verified.json。manifest 在首次 mutation 前保存固定的 issue UUID；关系也在写入前保存固定 UUID。下一轮若发现待发布 manifest，会先读回已创建项，再补未完成项，不重新调用 creator。请求结果不明时本轮停止，后续仍使用原 UUID，避免换新 ID 重复创建。

默认状态根目录的 `create/pending/` 保存待发布 manifest 的路径，不随自定义日志目录变化；恢复需要保留该 manifest。成功后删除 pending 指针，保留运行证据。scope、Team 或 Backlog 状态与 manifest 不符时停止该 route；修正配置或检查原 manifest 后恢复，不自动迁移已有候选。

创建进程对同一 Team 的发布持有本机锁；硬崩溃后与开发模式一样，先核对锁 owner 对应的 Herdr pane 已退出，再移除失效锁。creator 成功后清理分析 worktree；agent 失败或修改 worktree 时保留现场。创建后的恢复只依赖 manifest 和 Linear，不运行开发或合并阶段。失败事件包含已确认存在的 issue 映射；created/reused 统计本批已确认项，恢复后包含此前已创建的部分，不代表恢复过程重复执行了创建。

API 字段通过当前接口 introspection 核对：`IssueCreateInput.id` 与 `IssueRelationCreateInput.id` 均可指定，关系类型使用 `blocks`。参考 [Linear GraphQL](https://linear.app/developers/graphql) 和 [Issue relations](https://linear.app/docs/issue-relations)。
