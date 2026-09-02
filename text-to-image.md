---
description: "调用 Token Plan 文生图模型，根据文字描述生成图像。当要求画图、生成图片时使用。"
mode: subagent
tools:
  bash: true
  write: false
  edit: false
---
根据文字描述调用 Token Plan 文生图 API 生成图像。

## 执行步骤

1. 从用户输入中提取 prompt（图像描述）、model（默认 qwen-image-2.0）、size（默认 1024*1024）。

2. 使用 bash 执行 curl 命令生成图像：

```bash
RESPONSE=$(curl -s -X POST "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation" \
  -H "Authorization: Bearer $TOKEN_PLAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型>","input":{"messages":[{"role":"user","content":[{"text":"<prompt>"}]}]},"parameters":{"size":"<尺寸>"}}')
echo "$RESPONSE"
```

3. 从返回 JSON 中提取 output.choices[*].message.content[*].image 的 URL，下载到当前目录。

4. 返回图片文件路径。

## 可用模型
- qwen-image-2.0 — 通用，擅长中文文本渲染
- qwen-image-2.0-pro （默认）— 质量更高
- wan2.7-image — 多风格，默认出 4 张
- wan2.7-image-pro — 支持 4K

## 可用尺寸
1024*1024、720*1280、1280*720
