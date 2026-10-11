---
name: voxcpm-cli
description: "通过本地 VoxCPM CLI 生成语音、设计音色、克隆参考声音和批量配音，包含 Apple Silicon Mac 安装与排障。用户提到 VoxCPM、要求本地离线 TTS、用参考音频克隆声音，或指定此技能时使用；不用于模型训练或云端 TTS 服务。"
---

# VoxCPM CLI

用项目自带的 `voxcpm design|clone|batch` 完成生成，交付实际音频文件。用户已经选择 CLI 工作流，普通生成任务直接使用 CLI；需要网页试听时再启动 Web UI。

## 本机环境与入口

- 默认项目：`/Users/yang/workspace/VoxCPM`。用户指定其他仓库或环境时优先使用用户指定值。
- CLI：项目下 `.venv/bin/voxcpm`；Python：`.venv/bin/python`。无需激活虚拟环境，也不依赖全局 PATH。
- 默认模型：`openbmb/VoxCPM2`，输出通常为 48 kHz WAV。
- 2026-10-11 已在 Apple M3 Max / 48 GB、Python 3.11 上实测 Web UI 和 CLI 文本生成；这些是历史验证记录，不能代替当前环境检查。

后续命令示例使用以下变量；跨独立 shell 调用时重新定义，或直接使用绝对路径：

```bash
VOXCPM_REPO="${VOXCPM_REPO:-/Users/yang/workspace/VoxCPM}"
VOXCPM_BIN="$VOXCPM_REPO/.venv/bin/voxcpm"
VOXCPM_PY="$VOXCPM_REPO/.venv/bin/python"
```

先检查入口是否存在；首次使用某个环境或出现版本差异时读 `"$VOXCPM_BIN" --help` 和对应子命令帮助。缺依赖、缺模型或需要网页时读 [安装、缓存与 Web UI](references/setup-and-webui.md)，不要每次生成都重装。

Apple Silicon 使用 `--device mps --no-optimize`；没有可用 MPS 时可用 `--device cpu --no-optimize`。迁移到其他设备时按当地环境选 `auto` 或 `cuda`，不要将本机参数硬套到 NVIDIA 环境。

## 选择生成方式

| 请求 | 方式 | 关键输入 |
| --- | --- | --- |
| 读一段文字、按描述创造声音 | `design` | `--text`，可选 `--control` |
| 参考声音克隆、同时调节情绪或语速 | `clone` | `--reference-audio`，可选 `--control` |
| 根据原音频及准确转写延续声音 | `clone` | `--prompt-audio` + `--prompt-text` 或 `--prompt-file` |
| 多句、长文分段、多个配音文件 | `batch` | UTF-8 文本，每个非空行一个片段 |

按用户给出的正文、声音风格、参考文件、输出位置执行。用户未指定声音时使用简洁自然的描述即可；没有参考音频时用 `design`，不要虚构参考文件或转写。为输出选择有意义的新文件名；批量使用独立目录，避免覆盖或把旧结果误认为本次成功。

用户给出的相对输入/输出路径先按当前任务工作目录解析，再以绝对路径传给 CLI；不要因为切换到 VoxCPM 仓库而改变用户的文件位置。

以下示例假设主模型已缓存，所以带 `--local-files-only`。首次下载见安装参考。普通生成关闭降噪器；降噪只处理参考音频，具体启用方式见后文。

### 文本生成与音色设计

```bash
"$VOXCPM_BIN" design \
  --text '你好，欢迎使用本地语音合成。' \
  --control '年轻女性，声音自然清晰，语速适中' \
  --device mps --no-optimize --no-denoiser --local-files-only \
  --seed 42 \
  --output "$VOXCPM_REPO/output/voice-design.wav"
```

CLI 自动把 `--control` 包在正文前的括号中，控制描述本身不必加括号。固定 `--seed` 有助于复现，但不保证跨不同文本保持同一音色；需要稳定说话人时复用同一参考音频。模型遇到异常生成重试时可能调整种子，不承诺跨版本完全复现。

### 参考音频克隆

```bash
"$VOXCPM_BIN" clone \
  --text '今天为你介绍这个项目的主要功能。' \
  --reference-audio '/absolute/path/to/reference.wav' \
  --control '语气轻松，语速适中' \
  --device mps --no-optimize --no-denoiser --local-files-only \
  --output "$VOXCPM_REPO/output/voice-clone.wav"
```

执行前确认参考文件可读。参考音频尽量为清晰单人讲话，避免背景音乐。此模式不需要转写；风格描述是可选项。模型会处理参考音频的单声道转换和重采样，不要求用户预先转换成固定采样率。

### 带转写的延续式克隆

```bash
"$VOXCPM_BIN" clone \
  --text '这是接下来需要生成的新内容。' \
  --prompt-audio '/absolute/path/to/reference.wav' \
  --prompt-file '/absolute/path/to/reference-transcript.txt' \
  --reference-audio '/absolute/path/to/reference.wav' \
  --device mps --no-optimize --no-denoiser --local-files-only \
  --output "$VOXCPM_REPO/output/voice-continuation.wav"
```

`--prompt-file` 是参考音频的 UTF-8 转写，不是目标正文；也可以改用 `--prompt-text '参考音频实际说出的内容'`。二者不能同时提供。此模式不接受 `--control`；`--reference-audio` 可以同时提供，通常复用同一音频。没有准确转写时使用参考音频克隆，或在任务确有需要时获取转写。

`--text` 只写新内容，输出文件也仅含新生成内容，不会自动拼上原始参考音频。

### 批量与长文本

先把文本按句子或自然段组织为 UTF-8 文件，每个非空行对应一个输出。CLI 不会自动把一条超长文本切段。

```bash
"$VOXCPM_BIN" batch \
  --input '/absolute/path/to/segments.txt' \
  --output-dir "$VOXCPM_REPO/output/batch-voice" \
  --control '自然清晰的旁白' \
  --device mps --no-optimize --no-denoiser --local-files-only
```

- 只加载一次模型，随后逐条生成；不要为同一批文本并行启动多个模型进程。
- 空行被忽略，文件按非空行顺序命名为 `output_001.wav`、`output_002.wav` 等。
- 可加 `--reference-audio` 固定说话人；单独 `design`/无参考的批量生成不保证音色一致。
- 当前实现会捕获单条错误，**即使有失败也可能退出 0**。检查日志中的 `Batch finished: N/N succeeded` 和每个预期文件，不能只看退出码。
- 仅重试失败的条目，保留它们与原行号的映射。若用户要一个长音频，再按顺序拼接已验证且采样率一致的片段。

## 参数与已知限制

- 初次使用保留 `--cfg-value 2.0`、`--inference-timesteps 10` 默认值，再按实际质量或速度需求调整；不要承诺实时生成。
- `--normalize` 处理数字、日期等文字格式，不是音量归一化；只在需要时启用，首次可能加载额外资源。
- 在 MPS 上保留项目自动选择的 `float32`。当前项目注释记录低精度会导致噪声和重试，不主动设置 `VOXCPM_MPS_DTYPE=bfloat16/float16`。
- 每次单独启动 CLI 都重新加载模型到内存，但会复用磁盘下载缓存。网页与 CLI 是不同进程，不共享已加载的模型；不要为了生成而随意关闭用户正在使用的网页。
- `--local-files-only` 只控制主模型的 Hugging Face 下载，不能视为全进程禁止联网。基础缓存生成使用 `--no-denoiser` 并保持规范化和时间戳功能关闭；严格离线任务需确认其他启用组件的资源也在本地。
- 当前 CLI 没有提供 ZipEnhancer 路径时会传入 `None`；仅加 `--denoise` 可能不实际降噪。确需降噪时移除 `--no-denoiser`，同时加 `--denoise --zipenhancer-path iic/speech_zipenhancer_ans_multiloss_16k_base`，或指定已有本地降噪模型目录。
- 时间戳需要额外的 `voxcpm[timestamps]` 依赖和对齐模型；只有用户需要字幕/时间戳时再安装和使用，参数以当前 `--help` 为准。
- 任意用户文本含 shell 特殊字符时，用 Python `subprocess.run([...], check=True)` 的参数列表传给 CLI，避免把正文插入可执行 shell 字符串。

## 验证与交付

等待生成进程真正结束，保存需要排错的 stderr；单条生成应有成功退出状态与 `Saved audio to:` 日志。然后用技能附带的检查器确认输出可解码、有采样数据、数值有限且不是全静音：

```bash
"$VOXCPM_PY" /Users/yang/.agents/skills/voxcpm-cli/scripts/verify_audio.py \
  "$VOXCPM_REPO/output/voice-design.wav" --sample-rate 48000
```

批量输出用输入文件计算准确的预期列表：

```bash
"$VOXCPM_PY" /Users/yang/.agents/skills/voxcpm-cli/scripts/verify_audio.py \
  --batch-input '/absolute/path/to/segments.txt' \
  --output-dir "$VOXCPM_REPO/output/batch-voice" --sample-rate 48000
```

检查器输出 JSON，任意文件缺失或无效时非零退出。它不验证发音、音色相似度或文本覆盖率；没有试听或转写证据时不要宣称这些已验证。若使用其他版本模型，按实际输出采样率检查，或省略 `--sample-rate`。

最后给出实际音频的绝对路径链接、时长和必要的使用说明。批量如有失败，明确列出失败条目；不要把部分成功报告成全部完成。长任务期间简短报告下载、加载或生成进度。

## 资料与更新

- [官方快速开始](https://voxcpm.readthedocs.io/zh-cn/latest/quickstart.html)
- [官方使用指南](https://voxcpm.readthedocs.io/zh-cn/latest/usage_guide.html)
- 本机参数依据：`src/voxcpm/cli.py`；设备与精度依据：`src/voxcpm/model/utils.py`。

本技能依据当前仓库与已完成的实测编写。升级后若行为与文档不符，先核对本地 CLI 帮助和实现，再修正对应操作。
