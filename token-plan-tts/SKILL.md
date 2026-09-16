---
name: token-plan-tts
description: "调用 Token Plan 语音合成模型，把文本转成 mp3 音频文件。走 DashScope WebSocket 接口，需要 dashscope Python SDK。当用户要求语音合成、朗读文本、生成配音、text-to-speech 时使用。"
---

# Token Plan 语音合成

把文本转成语音文件。鉴权使用环境变量 `$TOKEN_PLAN_API_KEY`（`sk-sp-` 前缀的套餐 Key）。

依赖 DashScope Python SDK。本机有 `uv` 时用 `uv run --with dashscope python` 免安装运行；否则先 `pip install dashscope`。

## 执行步骤

1. 从用户输入中提取 text（待合成文本）、voice（音色，默认 longanhuan_v3.6）、model（默认 qwen-audio-3.0-tts-plus）。用户明确指定模型或音色时严格使用用户给的值。

2. 使用 bash 执行以下脚本生成音频：

```bash
uv run --with dashscope python - <<'EOF'
import os
from datetime import datetime
import dashscope
from dashscope.audio.tts_v2 import SpeechSynthesizer, AudioFormat

dashscope.api_key = os.environ["TOKEN_PLAN_API_KEY"]
dashscope.base_websocket_api_url = "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"

synthesizer = SpeechSynthesizer(
    model="qwen-audio-3.0-tts-plus",
    voice="longanhuan_v3.6",
    format=AudioFormat.MP3_22050HZ_MONO_256KBPS,
)

audio = synthesizer.call("<text>")
filename = f"speech_{datetime.now():%Y%m%d_%H%M%S}.mp3"
with open(filename, "wb") as f:
    f.write(audio)
print(f"音频已保存: {os.path.abspath(filename)}")
EOF
```

3. 向用户展示生成的音频文件路径。

## 采样率

`AudioFormat` 常量名决定采样率与码率（如 `MP3_22050HZ_MONO_256KBPS`、`MP3_24000HZ_MONO_256KBPS`）。需要非默认采样率时换对应常量即可，不必额外传参。
