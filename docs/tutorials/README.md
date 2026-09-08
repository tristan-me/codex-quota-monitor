# 安装教程媒体说明

[观看/下载 MP4](../media/codex-quota-monitor-cli-tutorial.mp4) · [GIF 预览](../media/codex-quota-monitor-cli-tutorial.gif) · [执行记录](../media/codex-quota-monitor-cli-execution.txt) · [媒体清单](../media/codex-quota-monitor-cli-tutorial.manifest.json)

视频为 50 秒、1280×720 的命令执行回放与桌面操作文字指引，没有录制 ChatGPT 的原生设置页或输入框。字幕和命令由程序生成，成功输出来自隔离配置中的实际本地 marketplace 注册与插件安装；机器路径已泛化为通用示例。`$PWD` 代表当前仓库目录，实际展开路径见脱敏执行记录。

GitHub 远程来源在本次网络环境中未完成安装，相关命令作为可选教学步骤出现，失败和超时记录保留在执行说明中。没有把未执行的克隆、原生新会话或真实账户启动展示为已完成。合成预览另行验证过，不代表用户真实账户。

This is a command replay and text walkthrough, not a recording of the ChatGPT desktop UI. Local marketplace registration and installation were verified in a temporary configuration. Public Git cloning did not complete on the recording machine's network. Paths are generalized, and the local URL shown in the video is a placeholder.

## 重新生成

需要 Python 3、Pillow，以及带 Command Line Tools 的 macOS。生成脚本仅重绘本目录的教程素材，不执行安装命令、不打开应用、不读取用户认证。

在仓库根目录运行：

```bash
python3 docs/tutorials/generate-cli-tutorial.py
swiftc docs/tutorials/encode-mp4.swift -o /tmp/quota-encode-video
python3 docs/tutorials/make-video-sequence.py /tmp/quota-video-sequence.json
/tmp/quota-encode-video /tmp/quota-video-sequence.json docs/media/codex-quota-monitor-cli-tutorial.mp4
```

MP4 使用系统 AVFoundation 编码器。它只读取生成的 PNG 帧，不捕获应用或屏幕。GitHub README 使用 GIF 预览，并链接完整 MP4。
