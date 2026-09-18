---
name: token-plan-image
description: "调用 Token Plan 文生图模型，根据文字描述生成图像并下载到本地。当用户要求画图、生成图片、出图、text-to-image 时使用。"
---

# Token Plan 文生图

根据文字描述调用 Token Plan 文生图 API 生成图像。鉴权使用环境变量 `$TOKEN_PLAN_API_KEY`（`sk-sp-` 前缀的套餐 Key）。

## 执行步骤

1. 从用户输入中提取 prompt（图像描述）、model（默认 wan2.7-image-pro）、size（默认 1024\*1024）。用户明确指定模型时必须严格使用该模型名，不要回退到默认值。

2. 使用 bash 执行 curl 生成图像：

```bash
curl -s -X POST "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation" \
  -H "Authorization: Bearer $TOKEN_PLAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model>","input":{"messages":[{"role":"user","content":[{"text":"<prompt>"}]}]},"parameters":{"size":"<size>"}}'
```

3. 从返回 JSON 的 `output.choices[*].message.content[*].image` 提取图片 URL（可能多张）。

4. 下载到当前目录：`curl -s -o "generated_$(date +%Y%m%d_%H%M%S).png" "<URL>"`

5. 向用户展示生成的图片文件路径。

## 可用模型

- wan2.7-image-pro（默认）— 功能最全，支持组图生成、最高 4096\*4096，强化五官/色彩/超长文字渲染；万相系列擅长插画、绘画流派、人像，游戏/概念图等风格化场景效果好
- wan2.7-image — 万相同系列，多风格
- qwen-image-3.0-pro — 千问图像3.0旗舰版，支持 prompt 智能改写，擅长文本渲染、精准生成贴合物理材质的中英文；商品海报、电商招牌、UI/PPT 等含文字排版场景更优

完整列表以千问AI平台模型列表为准。

## 可用尺寸

1024\*1024、720\*1280、1280\*720

## 排错

- `AccessDenied.Unpurchased` — 该模型未在套餐内开通，换已开通的模型。
- 免费探测某模型是否可用：故意传 `"size":"1*1"`，返回 `InvalidParameter` 说明有权限，返回 `AccessDenied.Unpurchased` 说明没开通。
