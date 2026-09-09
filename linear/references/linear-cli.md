# 本组 Linear CLI 约定

使用已安装的 [Finesssee/linear-cli](https://github.com/Finesssee/linear-cli)；实现已对照 0.3.27 的本地 help 和源码。可执行文件名为 `linear-cli`，结构化输出参数为 `--output json`。共用助手通过 `linear-cli api query/mutate` 复用认证，不另行读取或保存 API key。

`LINEAR_CLI_BIN` 可指定可执行文件，`LINEAR_CLI_PROFILE` 可选 workspace profile。watcher 自动传递这两项。所有 ID、Markdown 和 JSON 通过子进程参数数组传递，GraphQL 通过 stdin 传递，不能拼进 shell 命令。

## 读取

```bash
linear-cli --output json --no-cache issues get ENG-123 --comments
linear-cli --output json --no-cache --all statuses list --team ENG
linear-cli --output json --no-cache --all comments list ENG-123
linear-cli --output json --no-cache --all relations list ENG-123
bun /absolute/path/to/linear/scripts/linear-issue.ts get ENG-123
```

共用助手返回 issue UUID、真实状态、Team、Project、description。watcher 通过 `api query` 分页取出全部 `unstarted` issues，再严格匹配路由的 Todo 名称/ID；它不会把同类型的其他状态当作 Todo。所有查询关闭缓存，领取前再次读回。

## 写入

```bash
# 创建 worktree 之后才执行 start；合并和发布验证评论之后才执行 done。
bun "$helper" start ENG-123
bun "$helper" start ENG-123 --state "In Progress"
bun "$helper" done ENG-123 --state "Done"

# plan 是原生 issue Document，即使 issue 没有 Project 也可创建。
bun "$helper" plan ENG-123 --file /tmp/run/plan.md

# plan-url 必须是该 issue 已关联的 Document。
bun "$helper" todos ENG-123 --file /tmp/run/tasks.md --plan-url "$planUrl"

# 正文从文件读取；可重复传 --artifact 上传多个真实产物。
bun "$helper" comment ENG-123 --file /tmp/run/validation.md \
  --key run-id-commit-sha --artifact /tmp/run/test.log --artifact /tmp/run/screenshot.png
```

`start/done` 先读取 Team 的 workflow states，按 `started/completed` 类别和实际名称解析 ID，再更新并读回。多个候选无法确定时使用上下文中的具体状态，不硬编码状态 UUID。

`plan` 在 `issue.documents` 中按稳定标题查找，同名多份时报告歧义。通过 `documentCreate(input: { title, content, issueId })` 创建原生关联文档；CLI 的 `documents create --project` 不能替代这个关联。已有文档用 `documentUpdate`。每次写入后读回，返回 ID/URL。

`todos` 更新最新 description 中的固定二级标题区域，保留其他部分，并在观察到中途编辑时拒绝覆盖。Linear 的整段 description 更新没有在本助手中提供原子 compare-and-swap；同一 issue 的计划和进度只由一个协调器写入，发生竞争时以重新读取和合并内容为准。

`comment` 先分页查找 `Run: <key>` 标记，复用已发布的同 key 评论，避免请求超时后的盲目重发。正文或代码改变时使用新的 key。附件通过 Linear `fileUpload` 获取签名 URL，上传文件后把实际 asset URL 写入 comments。上传认证与签名请求仍经过 linear-cli，文件内容通过签名 URL PUT。依据：[Linear 文件上传](https://linear.app/developers/how-to-upload-a-file-to-linear)。

所有 mutation 都检查 success 并读取实际结果。不自动重试可能已成功的写入；出现超时先查 issue 的 Document、description、comments 或状态再决定。未返回且无法确认的结果应报告为未确认。
