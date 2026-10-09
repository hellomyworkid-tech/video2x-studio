#!/bin/bash
# 编译 C++ 核心（libvideo2x.dylib + video2x CLI）到 build-macos/。
# 用法：bash scripts/macos/build-core.sh [Debug|Release]
# 依赖：Homebrew 的 ffmpeg@7、ncnn（MoltenVK）、spdlog、fmt、boost、cmake、ninja；
#       third_party/lib*_ncnn_vulkan 源码（迁移包 restore-on-mac.sh 已解压到位）。
# 预期：第一次会失败在 [[gnu::target_clones(...)]] 上（x86/ELF 专用），见 docs/macos/02-windows-specific-inventory.md A 节。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TYPE="${1:-Release}"
BREW="$(brew --prefix)"
FFMPEG7="$(brew --prefix ffmpeg@7)"

for d in librealesrgan_ncnn_vulkan librealcugan_ncnn_vulkan librife_ncnn_vulkan; do
  [ -d "$ROOT/third_party/$d/src" ] || { echo "缺少 third_party/$d（用迁移包的 restore-on-mac.sh 恢复）"; exit 1; }
done

# ffmpeg@7 是 keg-only：pkg-config 必须显式指向它，否则可能找到普通 ffmpeg（9.x）或找不到
export PKG_CONFIG_PATH="$FFMPEG7/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

cmake -S "$ROOT" -B "$ROOT/build-macos" -G Ninja \
  -DCMAKE_BUILD_TYPE="$TYPE" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_PREFIX_PATH="$BREW" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DVIDEO2X_USE_EXTERNAL_NCNN=ON \
  -DVIDEO2X_USE_EXTERNAL_SPDLOG=ON \
  -DVIDEO2X_USE_EXTERNAL_BOOST=ON
cmake --build "$ROOT/build-macos" --parallel

ls -la "$ROOT/build-macos/video2x" "$ROOT/build-macos/libvideo2x.dylib"
otool -L "$ROOT/build-macos/libvideo2x.dylib" | grep -E "avcodec|ncnn|MoltenVK|vulkan" || true
echo "完成。试运行：$ROOT/build-macos/video2x -l"
