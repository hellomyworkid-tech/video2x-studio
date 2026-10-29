#!/bin/bash
# 编译 C++ 核心（libvideo2x.dylib + video2x CLI）到 build-macos/。
# 用法：bash scripts/macos/build-core.sh [Debug|Release]
# 依赖：FFmpeg 7.1（优先 build-ffmpeg.sh 编出的 third_party/ffmpeg-macos，否则 Homebrew 的 ffmpeg@7）、
#       Homebrew 的 ncnn（MoltenVK）、spdlog、fmt、boost、cmake、ninja；
#       third_party/lib*_ncnn_vulkan 源码（迁移包 restore-on-mac.sh 已解压到位）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TYPE="${1:-Release}"
BREW="$(brew --prefix)"
LIBOMP="$(brew --prefix libomp)"
MOLTENVK="$(brew --prefix molten-vk)"

for d in librealesrgan_ncnn_vulkan librealcugan_ncnn_vulkan librife_ncnn_vulkan; do
  [ -d "$ROOT/third_party/$d/src" ] || { echo "缺少 third_party/$d（用迁移包的 restore-on-mac.sh 恢复）"; exit 1; }
done

# FFmpeg：优先用 build-ffmpeg.sh 编出的 third_party/ffmpeg-macos（带 libplacebo，Anime4K 与 HDR 可用）；
# 没有就退回 Homebrew 的 ffmpeg@7（其余功能正常）。两者都是 keg 式安装，pkg-config 必须显式指向，
# 否则可能找到普通 ffmpeg（9.x）或找不到
FFMPEG_PREFIX="$ROOT/third_party/ffmpeg-macos"
if [ ! -f "$FFMPEG_PREFIX/lib/pkgconfig/libavcodec.pc" ]; then
  FFMPEG_PREFIX="$(brew --prefix ffmpeg@7)"
  echo "没有 third_party/ffmpeg-macos，改用 Homebrew ffmpeg@7：Anime4K 与 HDR 不可用（先运行 scripts/macos/build-ffmpeg.sh）"
fi
export PKG_CONFIG_PATH="$FFMPEG_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
# pkg_check_modules 的结果缓存在 CMakeCache.txt 里，换了 FFmpeg 不会重新查找：发现缓存里的库目录不同就 --fresh 重新配置
FRESH=""
FFMPEG_LIBDIR="$(pkg-config --variable=libdir libavcodec)"
if [ -f "$ROOT/build-macos/CMakeCache.txt" ] \
   && ! grep -qx "libavcodec_LIBDIR:INTERNAL=$FFMPEG_LIBDIR" "$ROOT/build-macos/CMakeCache.txt"; then
  echo "FFmpeg 换成了 $FFMPEG_LIBDIR，重新配置"
  FRESH="--fresh"
fi
# Homebrew 的 ncnn 带 libomp 编译，导出目标依赖 OpenMP::OpenMP_CXX；Apple Clang 不自带 OpenMP，
# 不指向 libomp（keg-only）的话 find_package(ncnn) 会在生成阶段报 "OpenMP::OpenMP_CXX not found"。
# 项目与 ncnn 封装库的 cmake_minimum_required 早于 3.12，要显式打开 CMP0074，OpenMP_ROOT 才会生效
# Vulkan 直接链接 MoltenVK（与 Homebrew 的 ncnn 一致），不经过 vulkan-loader。经 loader 的话，MoltenVK 属于
# portability 驱动，vulkan_utils.cpp 创建实例时没有声明 VK_KHR_portability_enumeration，
# video2x -l 会报 "Failed to create Vulkan instance"。
# 注意 libplacebo（Anime4K / HDR）自己链接 vulkan-loader，经 ICD 清单再加载同一个 MoltenVK，打包时 loader 与清单都要带上

cmake $FRESH -S "$ROOT" -B "$ROOT/build-macos" -G Ninja \
  -DCMAKE_BUILD_TYPE="$TYPE" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_PREFIX_PATH="$BREW" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DVIDEO2X_USE_EXTERNAL_NCNN=ON \
  -DVIDEO2X_USE_EXTERNAL_SPDLOG=ON \
  -DVIDEO2X_USE_EXTERNAL_BOOST=ON \
  -DCMAKE_POLICY_DEFAULT_CMP0074=NEW \
  -DOpenMP_ROOT="$LIBOMP" \
  -DVulkan_LIBRARY="$MOLTENVK/lib/libMoltenVK.dylib"
cmake --build "$ROOT/build-macos" --parallel

ls -la "$ROOT/build-macos/video2x" "$ROOT/build-macos/libvideo2x.dylib"
otool -L "$ROOT/build-macos/libvideo2x.dylib" | grep -E "avcodec|avfilter|ncnn|MoltenVK|vulkan" || true
echo "完成。试运行：$ROOT/build-macos/video2x -l"
