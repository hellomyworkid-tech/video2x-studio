#!/bin/bash
# 在 Mac 上用 testdata/reference-windows/commands.md 的同一组参数重跑，输出到 testdata/mac/（文件名与参考一致），
# 再用 compare.sh --all testdata/mac 逐帧比 PSNR（判定标准见 docs/macos/05-acceptance.md）。
# 用法：bash scripts/macos/run-reference.sh [名称片段 ...]
#   不带参数跑全部 13 项；带参数只跑名称包含任一片段的项，例：run-reference.sh lanczos rife
# 设备参数按 05-acceptance.md 替换：--device cuda:0 → --device mps，-d 0 不变。
# 验收打包结果：V2X_APP=<…/Video2X Studio.app> 时改用包内的核心、Python 与 worker，
#   以包内 Contents 为工作目录（与 bridge 一致，模型从包内找），环境变量照 platform.mjs 的 childEnv 设，
#   输出到 testdata/mac-app/，再 compare.sh --all testdata/mac-app。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
V2X=build-macos/video2x
PY=engine-python/.venv/bin/python
WORKER=engine-python/worker.py
IN=testdata/inputs
OUT=testdata/mac
if [ -n "${V2X_APP:-}" ]; then
  C="$V2X_APP/Contents"
  V2X="$C/build-macos/video2x"
  PY="$C/engine-python/python/bin/python3"
  WORKER="$C/engine-python/worker.py"
  IN="$ROOT/testdata/inputs"
  OUT="$ROOT/testdata/mac-app"
  export VK_DRIVER_FILES="$C/vulkan/icd.d/MoltenVK_icd.json" VIDEO2X_FFMPEG_DIR="$C/third_party/ffmpeg-macos/bin" PYTHONDONTWRITEBYTECODE=1
  cd "$C"
fi
mkdir -p "$OUT"
# worker.py 未设置 VIDEO2X_FFMPEG_DIR 时与 bridge 选同一份 FFmpeg（third_party/ffmpeg-macos，没有则 ffmpeg@7）

fails=0
run() {
  local name=$1; shift
  if [ -n "$FILTER" ]; then
    local hit=0 f
    for f in $FILTER; do case "$name" in *"$f"*) hit=1 ;; esac; done
    [ "$hit" = 1 ] || return 0
  fi
  local t0=$SECONDS
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  printf '%-24s 退出码 %d，耗时 %ds（日志 %s）\n' "$name" "$rc" $((SECONDS - t0)) "$OUT/$name.log"
  [ "$rc" = 0 ] || fails=$((fails + 1))
}
FILTER="$*"

run B_lanczos_x2        "$V2X" -i $IN/B.mp4 -o $OUT/B_lanczos_x2.mp4 -p lanczos -s 2 -c libx264 -e crf=18 --no-progress
run B_animevideov3_x2   "$V2X" -i $IN/B.mp4 -o $OUT/B_animevideov3_x2.mp4 -p realesrgan --realesrgan-model realesr-animevideov3 -s 2 -d 0 -c libx264 -e crf=18 --no-progress
run B_nomos8kcompact_x2 "$V2X" -i $IN/B.mp4 -o $OUT/B_nomos8kcompact_x2.mp4 -p realesrgan --realesrgan-model nomos8k-compact -s 2 -d 0 -c libx264 -e crf=18 --no-progress
run B_realcugan_se_x2   "$V2X" -i $IN/B.mp4 -o $OUT/B_realcugan_se_x2.mp4 -p realcugan --realcugan-model models-se -s 2 -n -1 -d 0 -c libx264 -e crf=18 --no-progress
run B_span_x2           "$V2X" -i $IN/B.mp4 -o $OUT/B_span_x2.mp4 -p span --span-model span -s 2 -d 0 -c libx264 -e crf=18 --no-progress
run B_rife426_x2fps     "$V2X" -i $IN/B.mp4 -o $OUT/B_rife426_x2fps.mp4 -p rife --rife-model rife-v4.26 -m 2 -d 0 -c libx264 -e crf=18 --no-progress
run B_anime4k_a         "$V2X" -i $IN/B.mp4 -o $OUT/B_anime4k_a.mp4 -p libplacebo --libplacebo-shader anime4k-v4-a -w 1708 -h 960 -d 0 -c libx264 -e crf=18 --no-progress
run B_lanczos_stab      "$V2X" -i $IN/B.mp4 -o $OUT/B_lanczos_stab.mp4 -p lanczos -s 2 --stab -c libx264 -e crf=18 --no-progress
run B_lanczos_denoise   "$V2X" -i $IN/B.mp4 -o $OUT/B_lanczos_denoise.mp4 -p lanczos -s 2 --denoise -c libx264 -e crf=18 --no-progress
run B_realbasicvsr      "$PY" "$WORKER" --model realbasicvsr -i $IN/B.mp4 -o $OUT/B_realbasicvsr.mp4 --device mps --crf 18
run B_swiftvr           "$PY" "$WORKER" --model swiftvr -i $IN/B.mp4 -o $OUT/B_swiftvr.mp4 --device mps --crf 18
run A_swiftvr_2k        "$PY" "$WORKER" --model swiftvr -i $IN/A.mp4 -o $OUT/A_swiftvr_2k.mp4 --device mps --crf 18
run B_seedvr2_960       "$PY" "$WORKER" --model seedvr2 -i $IN/B.mp4 -o $OUT/B_seedvr2_960.mp4 --device mps --resolution 960 --crf 18

echo "失败 $fails 项"
if pgrep -fl "worker.py|build-macos/video2x" >/dev/null 2>&1; then
  echo "警告：有残留进程"; pgrep -fl "worker.py|build-macos/video2x"
fi
[ "$fails" -eq 0 ]
