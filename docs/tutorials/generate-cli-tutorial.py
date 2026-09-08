#!/usr/bin/env python3
"""Render a synthetic-looking but evidence-labelled CLI command replay.

This is deliberately a terminal/log replay, not a desktop screen recording.
It never reads CODEX_HOME, launches Codex, opens a browser, or touches TCC.
The generated frame durations are consumed by the separate AVFoundation
encoder used for the MP4 deliverable.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "docs" / "media"
FRAMES = MEDIA / "codex-quota-monitor-cli-tutorial-frames"
GIF_PATH = MEDIA / "codex-quota-monitor-cli-tutorial.gif"
LOG_PATH = MEDIA / "codex-quota-monitor-cli-execution.txt"
MANIFEST_PATH = MEDIA / "codex-quota-monitor-cli-tutorial.manifest.json"

WIDTH, HEIGHT = 1280, 720
GIF_SIZE = (640, 360)
FRAME_DURATIONS = [4, 5, 5, 5, 4, 7, 5, 5, 5, 5]

FONT_DIR = Path("/System/Library/Fonts")
FONT_CJK = FONT_DIR / "STHeiti Medium.ttc"
FONT_CJK_LIGHT = FONT_DIR / "STHeiti Light.ttc"


def font(path: Path, size: int):
    return ImageFont.truetype(str(path), size)


F_TITLE = font(FONT_CJK, 34)
F_SUBTITLE = font(FONT_CJK_LIGHT, 20)
F_BODY = font(FONT_CJK_LIGHT, 22)
F_BODY_BOLD = font(FONT_CJK, 22)
F_SMALL = font(FONT_CJK_LIGHT, 17)
F_MONO = font(FONT_DIR / "Menlo.ttc", 20)
F_MONO_SMALL = font(FONT_DIR / "Menlo.ttc", 16)

BG = (14, 18, 27)
PANEL = (23, 30, 43)
PANEL_2 = (17, 23, 34)
WHITE = (235, 241, 248)
MUTED = (163, 178, 198)
CYAN = (116, 224, 213)
YELLOW = (246, 207, 115)
RED = (255, 134, 151)
GREEN = (139, 229, 164)
BLUE = (132, 184, 255)


def wrap_text(draw, text, used_font, max_width):
    """Wrap mixed CJK/ASCII text by measured pixel width."""
    parts = []
    current = ""
    for char in text:
        candidate = current + char
        if current and draw.textbbox((0, 0), candidate, font=used_font)[2] > max_width:
            parts.append(current)
            current = char
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts or [""]


def draw_header(draw, section, subtitle):
    draw.rounded_rectangle((34, 26, WIDTH - 34, 104), radius=16, fill=PANEL)
    draw.text((62, 43), "Codex Quota Monitor", font=F_TITLE, fill=WHITE)
    draw.text((62, 84), "CLI COMMAND REPLAY · 非桌面界面录屏", font=F_SMALL, fill=YELLOW)
    draw.text((WIDTH - 62, 48), section, font=F_BODY_BOLD, fill=CYAN, anchor="ra")
    draw.text((WIDTH - 62, 80), subtitle, font=F_SMALL, fill=MUTED, anchor="ra")


def draw_footer(draw, frame_index):
    draw.text((52, HEIGHT - 34), "本地安装已在隔离配置验证 · 路径已泛化 · 桌面步骤为文字指引", font=F_SMALL, fill=MUTED)
    draw.text((WIDTH - 52, HEIGHT - 34), f"{frame_index + 1:02d}/10", font=F_SMALL, fill=MUTED, anchor="ra")


def draw_terminal(draw, lines, top=142, bottom=650):
    draw.rounded_rectangle((48, top, WIDTH - 48, bottom), radius=14, fill=PANEL_2, outline=(51, 69, 91), width=2)
    draw.ellipse((72, top + 20, 84, top + 32), fill=RED)
    draw.ellipse((94, top + 20, 106, top + 32), fill=YELLOW)
    draw.ellipse((116, top + 20, 128, top + 32), fill=GREEN)
    y = top + 62
    for line, color in lines:
        f = F_BODY if any(ord(c) > 127 for c in line) else (F_MONO if line.startswith("$") else F_MONO_SMALL)
        for wrapped in wrap_text(draw, line, f, WIDTH - 150):
            draw.text((76, y), wrapped, font=f, fill=color)
            y += 34 if f is F_BODY else (30 if f is F_MONO else 25)
            if y > bottom - 22:
                return


def frame(section, subtitle, lines, frame_index, callout=None):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    draw_header(draw, section, subtitle)
    if callout:
        draw.rounded_rectangle((48, 118, WIDTH - 48, 130), radius=6, fill=callout[1])
        draw.text((76, 116), callout[0], font=F_SMALL, fill=callout[1])
        top = 160
    else:
        top = 142
    draw_terminal(draw, lines, top=top)
    draw_footer(draw, frame_index)
    return image


def make_frames():
    if FRAMES.exists():
        shutil.rmtree(FRAMES)
    FRAMES.mkdir(parents=True, exist_ok=True)
    frames = [
        frame("安装与打开", "开始前准备", [
            ("准备支持本地插件的 ChatGPT 桌面端、Node.js 22.13+ 和 Codex CLI。", WHITE),
            ("$ node --version", CYAN),
            ("$ codex --version", CYAN),
            ("本教程演示：获取仓库 → 安装插件 → 新会话打开 → 收藏面板。", WHITE),
            ("本地注册和安装已实际验证；桌面操作用文字说明。", MUTED),
        ], 0),
        frame("1 · 获取仓库", "准备步骤：需要访问 GitHub", [
            ("可在 GitHub 下载 ZIP 并解压，也可以运行：", WHITE),
            ("$ git clone https://github.com/tristan-me/codex-quota-monitor.git", CYAN),
            ("$ cd codex-quota-monitor", CYAN),
            ("后续命令在仓库根目录执行；应能看到 .agents 与 plugins 目录。", WHITE),
            ("本次验证使用已有仓库副本；远程下载未在本机网络环境完成。", MUTED),
        ], 1),
        frame("2 · 注册来源", "本地 marketplace · 已验证", [
            ("$ codex plugin marketplace add \"$PWD\"", CYAN),
            ("Added marketplace `codex-quota-monitor`", GREEN),
            ("Installed marketplace root: <local checkout>", GREEN),
            ("$PWD 表示当前仓库目录；路径在回放中已泛化。", WHITE),
            ("实际测试在独立临时配置中完成。", MUTED),
        ], 2),
        frame("3 · 安装插件", "安装命令 · 已验证", [
            ("$ codex plugin add codex-quota-monitor@codex-quota-monitor", CYAN),
            ("Added plugin `codex-quota-monitor`", GREEN),
            ("Installed plugin root: <local config>/plugins/cache/…", GREEN),
            ("名称中 @ 左侧是插件，右侧是 marketplace。", WHITE),
        ], 3),
        frame("4 · 确认启用", "CLI 实测 + 桌面文字指引", [
            ("$ codex plugin list", CYAN),
            ("codex-quota-monitor@codex-quota-monitor  installed, enabled", GREEN),
            ("也可在桌面端「设置 → 插件」中查看 Codex Quota Monitor。", WHITE),
            ("安装完成后请新建本地会话，以加载插件工具与技能。", CYAN),
        ], 4),
        frame("5 · 新会话打开", "桌面操作文字指引 · 未录制原生界面", [
            ("在新会话输入 @，选择 Codex Quota Monitor，然后发送：", WHITE),
            ("打开 Codex 额度监控器。", CYAN),
            ("完整引用文本：", MUTED),
            ("[@Codex Quota Monitor](plugin://codex-quota-monitor@codex-quota-monitor)", CYAN),
            ("打开 Codex 额度监控器。", CYAN),
            ("直接粘贴 Markdown 不一定形成插件标签，优先通过 @ 候选列表选择。", MUTED),
        ], 5),
        frame("6 · 打开与收藏", "使用聊天实际返回的网址", [
            ("插件会启动本地监控器，并在聊天回复中保留可点击链接。", WHITE),
            ("http://127.0.0.1:<port>/#<access-token>", CYAN),
            ("以上是地址格式示意，请使用自己聊天里返回的完整网址。", YELLOW),
            ("可收藏到浏览器；同一台电脑、服务仍运行时可直接打开。", WHITE),
            ("完整网址包含本地访问凭据，不要放到公开截图或仓库。", MUTED),
        ], 6),
        frame("7 · 再次启动", "关闭网页不会停止后台服务", [
            ("电脑重启或服务已停止时，书签不能自动启动服务或桌面应用。", WHITE),
            ("再次在本地会话 @ 插件打开即可。已有仓库也可手动启动：", WHITE),
            ("$ ./Open-Monitor.command", CYAN),
            ("或：", MUTED),
            ("$ node plugins/codex-quota-monitor/server/launcher.mjs", CYAN),
            ("macOS 可以直接双击 Open-Monitor.command。", MUTED),
        ], 7),
        frame("可选 · 远程来源", "网络通畅时可用 · 本次未验证成功", [
            ("$ codex plugin marketplace add", CYAN),
            ("  https://github.com/tristan-me/codex-quota-monitor", CYAN),
            ("$ codex plugin add codex-quota-monitor@codex-quota-monitor", CYAN),
            ("第一条命令是一行。若 GitHub 网络失败，可下载仓库后走本地注册。", WHITE),
            ("本机远程访问失败记录保留在配套执行日志中。", MUTED),
        ], 8),
        frame("更快 · 交给 Codex", "复制仓库链接，一句话开始", [
            ("也可以直接把下面这句话发送给 Codex：", WHITE),
            ("请安装并启动这个插件，完成后在聊天中给出可点击的网址：", CYAN),
            ("https://github.com/tristan-me/codex-quota-monitor", CYAN),
            ("安装完成 → 新会话 @ 插件 → 打开面板 → 收藏网址。", GREEN),
            ("配套文字命令、来源与视频说明见 README。", MUTED),
        ], 9),
    ]
    for index, image in enumerate(frames):
        image.save(FRAMES / f"frame-{index:03d}.png", optimize=True)
    return frames


def make_gif(frames):
    small = [image.resize(GIF_SIZE, Image.Resampling.LANCZOS).convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for image in frames]
    small[0].save(
        GIF_PATH,
        save_all=True,
        append_images=small[1:],
        duration=[int(value * 1000) for value in FRAME_DURATIONS],
        loop=0,
        optimize=True,
        disposal=2,
    )


EXECUTION_LOG = """CLI execution replay evidence (sanitized)
===============================================
Recording type: command execution replay, not desktop UI recording.
Real credentials, real account data, and real task IDs were not read.

Environment
-----------
$ codex --version
codex-cli 0.144.3

Remote marketplace route — attempted in isolated temporary CODEX_HOME
---------------------------------------------------------------------
$ codex plugin marketplace add https://github.com/tristan-me/codex-quota-monitor
Error: git clone https://github.com/tristan-me/codex-quota-monitor.git failed with status 128
fatal: unable to access the public GitHub URL: network connection failed in this runner
RESULT: not installed in this attempt; the tutorial labels remote installation as unverified on this network. A later isolated retry with network access timed out after 45 seconds.

$ codex plugin add codex-quota-monitor@codex-quota-monitor
Error: plugin `codex-quota-monitor` was not found in marketplace `codex-quota-monitor`
RESULT: expected follow-on failure because the preceding marketplace add failed.

Local marketplace route — executed successfully in isolated temporary CODEX_HOME
--------------------------------------------------------------------------------
$ codex plugin marketplace add <local checkout>
Added marketplace `codex-quota-monitor` from <local checkout>.
Installed marketplace root: <local checkout>

$ codex plugin add codex-quota-monitor@codex-quota-monitor
Added plugin `codex-quota-monitor` from marketplace `codex-quota-monitor`.
Installed plugin root: <isolated CODEX_HOME>/plugins/cache/.../0.2.0+codex...

$ codex plugin list
Marketplace `codex-quota-monitor`
codex-quota-monitor@codex-quota-monitor  installed, enabled
RESULT: success was limited to the isolated temporary CODEX_HOME.

Clone route — teaching commands, not falsely reported as executed here
-----------------------------------------------------------------------
$ git clone https://github.com/tristan-me/codex-quota-monitor.git ~/src/codex-quota-monitor
$ cd ~/src/codex-quota-monitor
$ codex plugin marketplace add "$PWD"
$ codex plugin add codex-quota-monitor@codex-quota-monitor

Launcher commands — teaching commands, live route not executed in this evidence run
------------------------------------------------------------------------------------
$ ./Open-Monitor.command
$ node plugins/codex-quota-monitor/server/launcher.mjs
These commands start the real local-account monitor when intentionally run by the user.

Synthetic preview — executed separately, no browser opened
------------------------------------------------------------
$ CODEX_QUOTA_MONITOR_PREVIEW_DIR=<isolated demo> node plugins/codex-quota-monitor/scripts/readme-preview.mjs
DEMO ONLY — synthetic README preview
No browser was opened. The demo process was stopped after verification.
"""


def write_evidence():
    LOG_PATH.write_text(EXECUTION_LOG, encoding="utf-8")
    manifest = {
        "title": "Codex Quota Monitor CLI command replay tutorial",
        "recordingType": "command-execution-replay",
        "notDesktopScreenRecording": True,
        "media": {
            "mp4": "docs/media/codex-quota-monitor-cli-tutorial.mp4",
            "gif": "docs/media/codex-quota-monitor-cli-tutorial.gif",
            "frames": "docs/media/codex-quota-monitor-cli-tutorial-frames/",
            "frameDurationsSeconds": FRAME_DURATIONS,
        },
        "routes": {
            "remoteGitMarketplace": {
                "commands": [
                    "codex plugin marketplace add https://github.com/tristan-me/codex-quota-monitor",
                    "codex plugin add codex-quota-monitor@codex-quota-monitor",
                ],
                "executed": True,
                "success": False,
                "result": "Public Git clone was blocked by the isolated runner's network; follow-on plugin add correctly reported the missing marketplace.",
            },
            "localMarketplace": {
                "commands": [
                    "codex plugin marketplace add <local checkout>",
                    "codex plugin add codex-quota-monitor@codex-quota-monitor",
                ],
                "executed": True,
                "success": True,
                "scope": "isolated temporary CODEX_HOME only",
            },
            "cloneAndLauncher": {
                "commands": [
                    "git clone https://github.com/tristan-me/codex-quota-monitor.git ~/src/codex-quota-monitor",
                    "codex plugin marketplace add \"$PWD\"",
                    "codex plugin add codex-quota-monitor@codex-quota-monitor",
                    "./Open-Monitor.command",
                    "node plugins/codex-quota-monitor/server/launcher.mjs",
                ],
                "executed": False,
                "note": "Teaching path; not claimed as successful in this isolated run. Live launcher deliberately not started.",
            },
        },
        "isolation": {
            "temporaryCODEXHome": True,
            "realAuthRead": False,
            "realAccountServiceStarted": False,
            "demoPreviewTested": True,
            "browserOpened": False,
            "newUserTaskCreated": False,
        },
        "evidence": "docs/media/codex-quota-monitor-cli-execution.txt",
        "caption": "视频包含本地安装命令回放与桌面操作文字指引，不是 ChatGPT/Codex 桌面界面录屏。",
        "commandPresentation": "Commands use portable spelling such as $PWD; expanded local paths are generalized. See the execution log for actual invocation scope.",
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    MEDIA.mkdir(parents=True, exist_ok=True)
    frames = make_frames()
    make_gif(frames)
    write_evidence()
    print(f"frames={FRAMES}")
    print(f"gif={GIF_PATH}")
    print(f"execution_log={LOG_PATH}")
    print(f"manifest={MANIFEST_PATH}")
    print(f"frame_durations_seconds={json.dumps(FRAME_DURATIONS)}")


if __name__ == "__main__":
    main()
