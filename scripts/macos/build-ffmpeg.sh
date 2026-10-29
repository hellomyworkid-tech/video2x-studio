#!/bin/bash
# 编译带 Vulkan + libplacebo 的 FFmpeg 7.1.5，装到 third_party/ffmpeg-macos/（third_party/ 已被 .gitignore 忽略）。
# Anime4K（libplacebo 处理器）与 SDR 转 HDR 要用 libplacebo 滤镜：Homebrew 的 ffmpeg@7 不带它，
# 普通 ffmpeg（9.x）不带 vidstab，且与 Windows 版（FFmpeg 7.1）不是同一代 API，所以自己编 7.1。
# 用法：bash scripts/macos/build-ffmpeg.sh [--force]
#   幂等：已装好同版本且带 libplacebo 时直接跳过；--force 强制重编。M5 Max 上约 5 分钟。
# 源码：ffmpeg.org 在国内连不上，默认取 FFmpeg 官方 GitHub 仓库的版本标签（与官网发布的源码相同），
#       可用环境变量 FFMPEG_TARBALL_URL 换地址；下载后核对 SHA-256，不符就停止。
# 编完要重新编译 C++ 核心（scripts/macos/build-core.sh 会自动改用这里的 FFmpeg）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VER=7.1.5
SHA256=e3963a50831c985933e1a625ed566ec4c7adb5c012c34fa9f84438e1d61bdacc
URL="${FFMPEG_TARBALL_URL:-https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n$VER}"
PREFIX="$ROOT/third_party/ffmpeg-macos"
SRC="$ROOT/third_party/ffmpeg-src"
FF="$PREFIX/bin/ffmpeg"

if [ "${1:-}" != "--force" ] && [ -x "$FF" ] \
   && "$FF" -hide_banner -version 2>/dev/null | head -1 | grep -q "version $VER " \
   && "$FF" -hide_banner -filters 2>/dev/null | grep -qw libplacebo; then
  echo "已装好：$("$FF" -hide_banner -version | head -1)（重编加 --force）"
  exit 0
fi

command -v brew >/dev/null 2>&1 || { echo "未找到 Homebrew（docs/macos/03-setup.md §0）"; exit 1; }
BREW="$(brew --prefix)"
# 只接项目用到的外部库：界面可选的编码器 x264 / x265 / libaom / libvpx，AV1 软解 dav1d，防抖 vidstab，
# zscale 用的 zimg，libplacebo（它自己会带上 shaderc 与 vulkan-loader）
DEPS="pkgconf x264 x265 aom libvpx dav1d libvidstab zimg libplacebo vulkan-headers"
MISSING=""
for p in $DEPS; do brew list --versions "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
[ -z "$MISSING" ] || brew install $MISSING

mkdir -p "$SRC"
TARBALL="$SRC/FFmpeg-n$VER.tar.gz"
if [ ! -f "$TARBALL" ] || ! shasum -a 256 "$TARBALL" | grep -q "^$SHA256 "; then
  echo "下载 FFmpeg n$VER 源码：$URL"
  curl -fL --retry 3 -o "$TARBALL.part" "$URL"
  mv "$TARBALL.part" "$TARBALL"
fi
shasum -a 256 "$TARBALL" | grep -q "^$SHA256 " || { echo "SHA-256 不符：$TARBALL（期望 $SHA256），已停止"; exit 1; }
[ -f "$SRC/FFmpeg-n$VER/configure" ] || tar -xzf "$TARBALL" -C "$SRC"

cd "$SRC/FFmpeg-n$VER"
# 官网发布包带 VERSION 文件，GitHub 标签包没有：缺了它 ffbuild/version.sh 会用 git describe 取版本，
# 源码目录在本仓库里，取到的是本仓库的提交号（ffmpeg -version 显示 "version 93ace62"）
echo "$VER" > VERSION
export PKG_CONFIG_PATH="$BREW/lib/pkgconfig:$BREW/share/pkgconfig"
# --disable-libxcb/xlib/sdl2/lzma：这些是 configure 自动探测到的 Homebrew 库，项目用不到，关掉免得打包时多带
echo "configure（日志 $SRC/configure.log）"
./configure --prefix="$PREFIX" \
  --enable-shared --disable-static --disable-doc --disable-ffplay \
  --enable-gpl \
  --enable-videotoolbox --enable-audiotoolbox \
  --enable-libx264 --enable-libx265 --enable-libaom --enable-libvpx --enable-libdav1d \
  --enable-libvidstab --enable-libzimg \
  --enable-vulkan --enable-libplacebo \
  --disable-libxcb --disable-xlib --disable-sdl2 --disable-lzma \
  --extra-cflags="-I$BREW/include" --extra-ldflags="-L$BREW/lib" \
  > "$SRC/configure.log" 2>&1 || { tail -30 "$SRC/configure.log"; exit 1; }
echo "make（日志 $SRC/make.log）"
make -j"$(sysctl -n hw.ncpu)" > "$SRC/make.log" 2>&1 || { tail -30 "$SRC/make.log"; exit 1; }
make install > "$SRC/install.log" 2>&1 || { tail -30 "$SRC/install.log"; exit 1; }

"$FF" -hide_banner -version | head -1
FILTERS=$("$FF" -hide_banner -filters 2>/dev/null)
ENCS=$("$FF" -hide_banner -encoders 2>/dev/null)
FAIL=0
for f in libplacebo vidstabdetect vidstabtransform zscale; do
  echo "$FILTERS" | grep -qw "$f" && echo "  滤镜 $f" || { echo "  缺少滤镜 $f"; FAIL=1; }
done
for e in libx264 libx265 libaom-av1 libvpx-vp9 h264_videotoolbox hevc_videotoolbox; do
  echo "$ENCS" | grep -qw "$e" && echo "  编码器 $e" || { echo "  缺少编码器 $e"; FAIL=1; }
done
[ "$FAIL" = 0 ] || exit 1
echo "完成：$PREFIX。接着运行 bash scripts/macos/build-core.sh 重新编译核心"
