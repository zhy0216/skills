---
name: token-plan-video
description: "调用 Token Plan 文生视频模型，根据文字描述生成视频并自动下载到本地。异步接口：提交任务 → 轮询状态 → 下载。当用户要求生成视频、文生视频、text-to-video 时使用。"
---

# Token Plan 文生视频

根据文字描述调用 Token Plan 文生视频 API 生成视频。鉴权使用环境变量 `$TOKEN_PLAN_API_KEY`（`sk-sp-` 前缀的套餐 Key）。

视频生成是异步接口，流程为「提交任务 → 轮询状态 → 下载视频」，一次生成通常需要数分钟。

## 执行步骤

1. 从用户输入中提取 prompt（视频描述）、model（默认 happyhorse-1.1-t2v）、resolution（默认 720P）、ratio（默认 16:9）、duration（默认 5 秒）。用户明确指定模型时必须严格使用该模型名。

2. 使用 bash 执行以下脚本，一次性完成提交、轮询、下载：

```bash
BASE="https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1"
TASK_RESPONSE=$(curl -s -X POST "$BASE/services/aigc/video-generation/video-synthesis" \
  -H "X-DashScope-Async: enable" \
  -H "Authorization: Bearer $TOKEN_PLAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model>","input":{"prompt":"<prompt>"},"parameters":{"resolution":"<resolution>","ratio":"<ratio>","duration":<duration>}}')
TASK_ID=$(echo "$TASK_RESPONSE" | grep -o '"task_id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TASK_ID" ]; then echo "提交失败: $TASK_RESPONSE"; exit 1; fi
echo "任务已提交，ID: $TASK_ID，等待生成..."
for i in $(seq 1 60); do
  sleep 15
  STATUS_RESPONSE=$(curl -s "$BASE/tasks/$TASK_ID" -H "Authorization: Bearer $TOKEN_PLAN_API_KEY")
  STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"task_status":"[^"]*"' | cut -d'"' -f4)
  if [ "$STATUS" = "SUCCEEDED" ]; then
    VIDEO_URL=$(echo "$STATUS_RESPONSE" | grep -o '"video_url":"[^"]*"' | cut -d'"' -f4)
    OUTPUT="generated_$(date +%Y%m%d_%H%M%S).mp4"
    curl -s -o "$OUTPUT" "$VIDEO_URL"
    echo "视频已下载: $(pwd)/$OUTPUT"
    exit 0
  elif [ "$STATUS" = "FAILED" ]; then
    echo "生成失败: $STATUS_RESPONSE"; exit 1
  fi
  echo "[$i] $STATUS"
done
echo "超时未完成，可手动查询: curl -s $BASE/tasks/$TASK_ID -H \"Authorization: Bearer \$TOKEN_PLAN_API_KEY\""
exit 1
```

> 脚本最长轮询 15 分钟，会超过 bash 工具默认超时。执行时把 timeout 调大（如 900000ms）；若仍超时，用最后打印的 `task_id` 手动查询并下载。

3. 向用户展示生成的视频文件路径。

## 可用模型

- happyhorse-1.1-t2v（默认）— 文生视频
- happyhorse-1.1-r2v — 参考图生视频，必须额外传 `input.media`（参考图 URL），否则报 `Field required: input.media`

完整列表以千问AI平台模型列表为准。

## 参数

- `resolution`：只接受 `480P` / `720P` / `1080P`
- `ratio`：如 `16:9`、`9:16`、`1:1`
- `duration`：秒，整数（不加引号）

## 排错

- 异步接口提交时**不校验参数**，永远先返回 `task_id` + `PENDING`。参数错误要等轮询到 `FAILED` 才看得到 `code` / `message`。
- 480P / 5 秒约 1 分钟出片；分辨率越高越久。
