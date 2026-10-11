# 安装、缓存与 Web UI

仅在首次准备环境、依赖/下载故障或用户需要网页时读取。日常生成回到 `SKILL.md` 的 CLI 流程。

## 检查现有安装

默认仓库为 `/Users/yang/workspace/VoxCPM`。沿用有效的 `.venv` 和模型缓存。

```bash
VOXCPM_REPO="${VOXCPM_REPO:-/Users/yang/workspace/VoxCPM}"
"$VOXCPM_REPO/.venv/bin/python" -c 'import torch; print("PyTorch:", torch.__version__, "MPS:", torch.backends.mps.is_available())'
"$VOXCPM_REPO/.venv/bin/voxcpm" design --help
uv pip check --python "$VOXCPM_REPO/.venv/bin/python"
```

本机 2026-10-11 安装记录：Python 3.11.12、torch 2.14.1、torchaudio 2.11.0、torchcodec 0.17.0、Gradio 6.30.0；这些版本组合已通过导入、MPS 运算与生成检查，但不是后续安装必须锁死的版本。当前安装清单曾保存于项目 `output/installed-requirements.txt`，存在时可用于排错。

## 新建或修复环境

已有仓库就在仓库目录操作。如果目录不存在，先确认用户指定位置；需要新下载时使用官方仓库 `https://github.com/OpenBMB/VoxCPM.git`，不要覆盖已有目录。

在仓库内执行：

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e .
uv pip check --python .venv/bin/python
```

仅在缺少环境时执行 `uv venv`；健康环境直接复用。已存在但有问题时根据实际异常修复依赖，避免默认删除重建。若没有 `uv`，可用现有 Python 3.11 的 `python3.11 -m venv .venv` 和 `.venv/bin/python -m pip install -e .`。

当前仓库声明 Python ≥ 3.10，README 建议小于 3.13；Python 3.11 是本机已验证选择。Mac 路径不需要 CUDA 或 Triton。不要把 README 通用 CUDA 要求当成 Mac 的安装条件。

检查音频解码环境：

```bash
command -v ffmpeg
.venv/bin/python -c 'import torch, torchaudio, torchcodec, soundfile; print(torch.__version__, torchaudio.__version__, torchcodec.__version__)'
```

本机已有 Homebrew FFmpeg。若缺少且出现相关解码错误，安装 `brew install ffmpeg` 后复查；TorchCodec 动态库错误需要同时核对当前 TorchCodec、PyTorch 与 FFmpeg 兼容范围，不盲目升级全部依赖。

## 下载与缓存主模型

VoxCPM2 约 20 亿参数；2026-10-11 官方文件列表约 4.96 GB，其中主权重 4.58 GB、AudioVAE 377 MB。下载体积不等于运行内存；Mac 的 float32 权重、缓存与辅助模型会额外占内存。数据源：[官方模型文件](https://huggingface.co/openbmb/VoxCPM2/tree/main)。

首次可以直接执行 `design` 且不加 `--local-files-only`，也可以显式预下载：

```bash
.venv/bin/python -u - <<'PY'
from huggingface_hub import snapshot_download
print(snapshot_download('openbmb/VoxCPM2', max_workers=4))
PY
```

默认缓存通常为 `~/.cache/huggingface/hub/models--openbmb--VoxCPM2/`；尊重已有的 `HF_HOME`、`HF_HUB_CACHE` 或 `--cache-dir` 设置，不硬编码某个 snapshot 哈希。用 `snapshot_download(..., local_files_only=True)` 可定位已有缓存，完整可用性最终以实际模型加载为准。已有本地完整模型目录也可用 `--model-path /absolute/path/to/model`。

缓存缺失时，在线任务可以补下载；严格离线任务应说明缺哪些资源或使用用户提供的本地目录。不要用去掉离线参数的方式悄悄改变严格离线要求。遇到网络超时可提高 `HF_HUB_DOWNLOAD_TIMEOUT` 并复用已有下载进度；不要默认清空缓存或切换不明镜像。

## Mac 设备与常见错误

| 现象 | 操作 |
| --- | --- |
| MPS 可用 | 使用 `--device mps --no-optimize`，保留项目自动选的 float32 |
| `Requested device 'mps' ... not available` | 检查是否为 arm64 Python、PyTorch 的 MPS 支持及系统版本；暂用 `--device cpu --no-optimize` |
| CUDA/Triton/编译优化错误 | Mac 命令添加 `--no-optimize`，不尝试安装 CUDA |
| 某个算子不支持 MPS | 根据具体异常尝试 `PYTORCH_ENABLE_MPS_FALLBACK=1`；并非所有故障都能 fallback，仍失败再用 CPU 验证 |
| 显存/统一内存不足 | 避免同时加载多个模型进程，拆短文本；如需释放正在运行的服务，先确认所属任务与使用情况 |
| 生成噪声或持续重试 | 检查是否设置了 `VOXCPM_MPS_DTYPE` 低精度覆盖，恢复默认 float32；再检查输入长度和参考音频 |
| 克隆报音频读取错误 | 先验证参考文件，再查 FFmpeg/TorchCodec，不要把输入格式故障当成模型故障 |

验证安装只需一次短句生成和文件检查；已完成后不要无故反复做模型实测。

## 可选 Web UI

仅当用户需要网页试听/上传音频时启动；CLI 自身不依赖网页服务。

先检查端口是否已被本项目占用：

```bash
lsof -nP -iTCP:8808 -sTCP:LISTEN
```

已有本项目服务时复用 `http://127.0.0.1:8808`。端口属于其他服务时选择空闲端口，不盲目杀进程。没有服务则在项目目录启动：

```bash
.venv/bin/python app.py --device mps --host 127.0.0.1 --port 8808
```

需要后台常驻时使用宿主工具支持的长期进程，或用 Python `subprocess.Popen(..., start_new_session=True)` 并将 stdin 设为 `DEVNULL`、stdout/stderr 写到项目 `output/webui.log`，将 PID 写到 `output/webui.pid`。先确认不是已有实例；历史 PID 文件不代表进程仍属于本项目。

网页首次生成会延迟加载模型，默认还初始化 ZipEnhancer；极致克隆自动转写会另下载/加载 SenseVoiceSmall，并在 Mac 上使用 CPU。只收到页面 HTTP 200 不代表推理已成功；首次安装后需通过页面或已有 Gradio API 生成一次并验证音频。

2026-10-11 曾以 `127.0.0.1:8808` 启动服务并留下上述日志/PID 文件。以后必须重新检查状态，不能宣称历史服务仍然运行。

## MCP 与调用方式边界

用户已选择 CLI，默认无需安装 MCP 或修改 agent 全局配置。若用户后续明确需要 MCP，再单独处理：Gradio 支持 `gradio[mcp]` + `GRADIO_MCP_SERVER=True`，但当前 App 的参考音频参数在 MCP schema 中可能被标为必填，纯文本调用需要核验并修整接口；不要仅开启服务就宣称 agent 调用已经跑通。
