#!/bin/bash
# macOS 开发环境体检（只读：不安装、不修改任何文件）。
# 用法：bash scripts/macos/doctor.sh
# 注意：在 Windows 上编写，未在 Mac 上实测过；第一次运行请边跑边修。macOS 自带 bash 3.2，本脚本不用 bash 4 语法。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ok()      { printf '  [OK]   %s\n' "$1"; }
warn()    { printf '  [WARN] %s\n' "$1"; }
bad()     { printf '  [FAIL] %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }

section "硬件与系统"
echo "  芯片：$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
echo "  统一内存：${MEM_GB} GB"
echo "  macOS：$(sw_vers -productVersion)（$(sw_vers -buildVersion)），架构 $(uname -m)"
system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|Total Number of Cores|Metal Support" | sed 's/^ */  /'
[ "$(uname -m)" = "arm64" ] && ok "Apple Silicon" || bad "不是 Apple Silicon（本移植方案按 arm64 设计）"
OS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
if [ "$OS_MAJOR" -ge 14 ]; then ok "macOS ≥ 14（MPS 支持 bf16）"; else warn "macOS < 14：MPS 不支持 bf16，SwiftVR 只能用 fp16"; fi
if   [ "$MEM_GB" -ge 36 ]; then ok "内存档位：≥36 GB——SwiftVR 2K 有希望（待实测）"
elif [ "$MEM_GB" -ge 24 ]; then warn "内存档位：24～35 GB——SwiftVR 预计 1080p 级，SeedVR2 低分辨率"
else warn "内存档位：<24 GB——SwiftVR 不可行（bf16 权重约 10 GB），以 ncnn 引擎为主"; fi

section "命令行工具"
for c in xcode-select brew git cmake ninja pkg-config node npm; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c"; else bad "缺少 $c"; fi
done
xcode-select -p >/dev/null 2>&1 && ok "Xcode 命令行工具：$(xcode-select -p)" || bad "未安装 Xcode 命令行工具（xcode-select --install）"
command -v node >/dev/null 2>&1 && echo "  node $(node --version)，npm $(npm --version)"

section "Homebrew 包"
if command -v brew >/dev/null 2>&1; then
  for f in ffmpeg@7 ncnn molten-vk vulkan-loader vulkan-headers vulkan-tools spdlog fmt boost python@3.12 node; do
    v=$(brew list --versions "$f" 2>/dev/null)
    if [ -n "$v" ]; then ok "$v"; else bad "未安装 $f"; fi
  done
  brew list --versions ffmpeg >/dev/null 2>&1 && warn "同时装了普通 ffmpeg（9.x，无 vidstab/libplacebo）：确保构建与运行用的是 7.1（下一节）"
fi

section "FFmpeg 7.1"
# 与 ui/server/platform.mjs 的 ffmpegDir 同一顺序：环境变量 → 自编的 third_party/ffmpeg-macos → Homebrew ffmpeg@7
if [ -n "${VIDEO2X_FFMPEG_DIR:-}" ]; then FFDIR="$VIDEO2X_FFMPEG_DIR"
elif [ -x "$ROOT/third_party/ffmpeg-macos/bin/ffmpeg" ]; then FFDIR="$ROOT/third_party/ffmpeg-macos/bin"
else
  FFDIR="$(brew --prefix ffmpeg@7 2>/dev/null)/bin"
  warn "没有自编 FFmpeg（third_party/ffmpeg-macos），用 Homebrew ffmpeg@7：Anime4K 与 HDR 不可用（scripts/macos/build-ffmpeg.sh）"
fi
FF="$FFDIR/ffmpeg"
if [ -x "$FF" ]; then
  ok "$("$FF" -hide_banner -version | head -1)（$FFDIR）"
  FILTERS=$("$FF" -hide_banner -filters 2>/dev/null)
  for flt in vidstabdetect vidstabtransform hqdn3d nlmeans libplacebo zscale; do
    if echo "$FILTERS" | grep -qw "$flt"; then ok "滤镜 $flt"; else
      case $flt in libplacebo|zscale) warn "滤镜 $flt 不可用（Anime4K/HDR 需要，scripts/macos/build-ffmpeg.sh）";; *) bad "滤镜 $flt 不可用";; esac
    fi
  done
  ENCS=$("$FF" -hide_banner -encoders 2>/dev/null)
  for enc in libx264 libx265 libaom-av1 libvpx-vp9 h264_videotoolbox hevc_videotoolbox; do
    echo "$ENCS" | grep -qw "$enc" && ok "编码器 $enc" || warn "编码器 $enc 不可用"
  done
  "$FF" -hide_banner -hwaccels 2>/dev/null | grep -qw videotoolbox && ok "硬件解码 videotoolbox" || warn "无 videotoolbox 硬件解码"
  FFLIB="$(cd "$FFDIR/.." && pwd)/lib"
  PKG_CONFIG_PATH="$FFLIB/pkgconfig" pkg-config --modversion libavcodec >/dev/null 2>&1 \
    && ok "pkg-config 能找到它的 libavcodec $(PKG_CONFIG_PATH="$FFLIB/pkgconfig" pkg-config --modversion libavcodec)" \
    || bad "pkg-config 在 $FFLIB/pkgconfig 找不到 libavcodec"
  # 界面按这份 ffmpeg 有没有 libplacebo 放开 Anime4K/HDR，核心也必须链接同一份，否则会在处理时才报找不到滤镜
  if [ -f "$ROOT/build-macos/libvideo2x.dylib" ]; then
    CORE_FFLIB=$(dirname "$(otool -L "$ROOT/build-macos/libvideo2x.dylib" | awk '/libavfilter/{print $1}')")
    if [ "$CORE_FFLIB" = "$FFLIB" ]; then ok "核心链接的是同一份 FFmpeg"
    else bad "核心链接的是 $CORE_FFLIB，界面用的是 $FFLIB：重新运行 scripts/macos/build-core.sh"; fi
  fi
else
  bad "找不到 $FF（scripts/macos/build-ffmpeg.sh，或 brew install ffmpeg@7）"
fi

section "Vulkan / MoltenVK（ncnn 引擎依赖）"
if command -v vulkaninfo >/dev/null 2>&1; then
  vulkaninfo --summary 2>/dev/null | grep -E "deviceName|deviceType|apiVersion|driverName" | sed 's/^ */  /' | head -8
  vulkaninfo --summary >/dev/null 2>&1 && ok "vulkaninfo 运行成功" || bad "vulkaninfo 失败：检查 molten-vk / vulkan-loader（VK_ICD_FILENAMES）"
else
  warn "没有 vulkaninfo（brew install vulkan-tools）"
fi
if [ -x "$ROOT/build-macos/video2x" ]; then
  echo "  video2x -l："; "$ROOT/build-macos/video2x" -l 2>&1 | head -6 | sed 's/^/    /'
else
  warn "尚未编译 C++ 核心（scripts/macos/build-core.sh）"
fi

section "Python / PyTorch MPS"
PY="$ROOT/engine-python/.venv/bin/python"
if [ -x "$PY" ]; then
  ok "$("$PY" --version 2>&1)（$PY）"
  "$PY" "$ROOT/scripts/macos/mps_smoke.py"
  "$PY" - <<'PYEOF'
import importlib
for m in ('diffusers', 'transformers', 'safetensors', 'cv2', 'einops', 'omegaconf', 'rotary_embedding_torch', 'numpy'):
    try:
        mod = importlib.import_module(m)
        print(f'  [OK]   import {m} {getattr(mod, "__version__", "")}')
    except Exception as e:
        print(f'  [FAIL] import {m}: {e}')
PYEOF
  if [ -f "$ROOT/engine-python/swiftvr-libs/diffusers/__init__.py" ]; then
    v=$(grep -m1 "__version__" "$ROOT/engine-python/swiftvr-libs/diffusers/__init__.py" | cut -d'"' -f2)
    ok "SwiftVR 覆盖层 diffusers $v"
  else
    bad "缺少 SwiftVR 覆盖层 engine-python/swiftvr-libs（diffusers 0.36）"
  fi
else
  bad "没有 engine-python/.venv（见 docs/macos/03-setup.md §3）"
fi

section "仓库与资产"
for d in models/realesrgan models/realcugan models/rife models/span models/libplacebo \
         third_party/librealesrgan_ncnn_vulkan third_party/librealcugan_ncnn_vulkan third_party/librife_ncnn_vulkan; do
  [ -d "$ROOT/$d" ] && ok "$d" || bad "缺少 $d"
done
for f in engine-python/weights/realbasicvsr_x4.pth \
         engine-python/weights/SeedVR2-3B/ema_vae_fp16.safetensors \
         engine-python/weights/SwiftVR/swiftvr_transformer_fp8.safetensors \
         engine-python/weights/SwiftVR/reae.safetensors \
         engine-python/weights/SwiftVR/prompt_embedding.safetensors \
         engine-python/weights/SwiftVR/transformer/config.json; do
  [ -f "$ROOT/$f" ] && ok "$f" || bad "缺少 $f"
done
[ -f "$ROOT/engine-python/weights/SeedVR2-3B/seedvr2_ema_3b_fp16.safetensors" ] \
  && ok "SeedVR2 fp16 DiT" || warn "缺少 SeedVR2 fp16 DiT（Mac 必需，下载方法见 03-setup.md §5）"
[ -f "$ROOT/engine-python/weights/SwiftVR/transformer/diffusion_pytorch_model.safetensors" ] \
  && ok "SwiftVR 官方 FP32 权重（可选）" || echo "  [INFO] 没有 SwiftVR 官方 FP32 权重（可选）"
[ -d "$ROOT/testdata/reference-windows" ] && ok "testdata/reference-windows（$(ls "$ROOT/testdata/reference-windows"/*.mp4 2>/dev/null | wc -l | tr -d ' ') 个参考输出）" || warn "缺少 testdata（验收对比用）"
[ -d "$ROOT/ui/node_modules" ] && ok "ui/node_modules" || warn "尚未 npm ci"

section "残留进程"
if pgrep -fl "worker.py|build-macos/video2x|ffmpeg" >/dev/null 2>&1; then
  warn "有残留进程："; pgrep -fl "worker.py|build-macos/video2x|ffmpeg" | sed 's/^/    /'
else
  ok "无残留 worker / video2x / ffmpeg 进程"
fi
echo
