#!/bin/bash
# macOS 开发环境一键安装（幂等，可重复运行）：Homebrew 依赖 → 自编 FFmpeg 7.1（带 libplacebo）→ Python 虚拟环境
# → SwiftVR 覆盖层 → npm 依赖 → 体检。
# 用法：bash scripts/macos/bootstrap.sh [--cn]
#   --cn  本次运行使用国内镜像（Homebrew 清华源、PyPI 清华源、npmmirror、Electron 镜像）
# 前提：已装 Xcode 命令行工具与 Homebrew（见 docs/macos/03-setup.md §0）。
# 注意：在 Windows 上编写，未在 Mac 上实测过；第一次运行请边跑边修并提交修正。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
step() { printf '\n==> %s\n' "$1"; }

if [ "${1:-}" = "--cn" ]; then
  export HOMEBREW_API_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
  export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
  export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
  export npm_config_registry="https://registry.npmmirror.com"
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  echo "已启用国内镜像（仅本次运行）"
fi

command -v brew >/dev/null 2>&1 || { echo "未找到 Homebrew，请先安装（docs/macos/03-setup.md §0）"; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "未安装 Xcode 命令行工具：xcode-select --install"; exit 1; }

step "Homebrew 依赖"
PKGS="cmake ninja pkgconf git ffmpeg@7 ncnn molten-vk vulkan-loader vulkan-headers vulkan-tools spdlog fmt boost python@3.12 node"
MISSING=""
for p in $PKGS; do brew list --versions "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then brew install $MISSING; else echo "全部已安装"; fi

step "FFmpeg 7.1（带 libplacebo，Anime4K 与 HDR 用）third_party/ffmpeg-macos"
# 首次约 5 分钟；已装好时直接跳过。源码取自 FFmpeg 官方 GitHub 仓库（国内可直连），核对 SHA-256
bash "$ROOT/scripts/macos/build-ffmpeg.sh"

step "Python 3.12 虚拟环境 engine-python/.venv"
PY312="$(brew --prefix python@3.12)/bin/python3.12"
VENV="$ROOT/engine-python/.venv"
[ -x "$VENV/bin/python" ] || "$PY312" -m venv "$VENV"
"$VENV/bin/pip" install -U pip
"$VENV/bin/pip" install -r "$ROOT/engine-python/requirements-macos.txt"

step "SwiftVR 依赖覆盖层 engine-python/swiftvr-libs（diffusers 0.36，不带 decord）"
if [ ! -f "$ROOT/engine-python/swiftvr-libs/diffusers/__init__.py" ]; then
  "$VENV/bin/pip" install --no-deps --target "$ROOT/engine-python/swiftvr-libs" diffusers==0.36.0
else
  echo "已存在"
fi

step "前端依赖（ui/node_modules）"
if [ ! -d "$ROOT/ui/node_modules" ]; then (cd "$ROOT/ui" && npm ci); else echo "已存在（需要重装时删掉 ui/node_modules 再运行）"; fi
# Electron 43 起 npm ci 不再下载本体，首次运行时才去下载（且不一定带上镜像变量），这里显式下好
if [ ! -f "$ROOT/ui/node_modules/electron/path.txt" ]; then (cd "$ROOT/ui" && node node_modules/electron/install.js); fi
echo "Electron $("$ROOT/ui/node_modules/.bin/electron" --version)"

step "体检"
bash "$ROOT/scripts/macos/doctor.sh"
