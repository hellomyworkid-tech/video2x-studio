#!/bin/bash
# 与 Windows 参考输出逐帧比 PSNR（判定标准见 docs/macos/05-acceptance.md）。
# 用法：
#   bash scripts/macos/compare.sh <Mac 输出.mp4> <参考输出.mp4>
#   bash scripts/macos/compare.sh --all <Mac 输出目录>     # 与 testdata/reference-windows/ 下同名文件逐个比较
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FFDIR="${VIDEO2X_FFMPEG_DIR:-$(brew --prefix ffmpeg@7 2>/dev/null)/bin}"
FFMPEG="$FFDIR/ffmpeg"; FFPROBE="$FFDIR/ffprobe"
[ -x "$FFMPEG" ] || { echo "找不到 $FFMPEG（设置 VIDEO2X_FFMPEG_DIR 或 brew install ffmpeg@7）"; exit 2; }

# 每个参考文件的阈值：平均 PSNR 下限、单帧下限，以及"最接近的错误结果"的实测 PSNR（校准依据）。
# 阈值必须高于错误结果，否则发现不了"模型用错 / 降噪没生效"之类的问题。
# 校准数据（Windows 参考集内两两比较）：nomos8k-compact vs animevideov3 36.6 dB；realcugan vs animevideov3 39.7；
# span vs lanczos 39.7；anime4k vs lanczos 38.1；降噪开 vs 关 44.6（最紧）；防抖开 vs 关 18.8；
# swiftvr vs seedvr2 31.8；swiftvr vs lanczos 33.5；seedvr2 vs lanczos 35.2。详见 docs/macos/05-acceptance.md。
thresholds() {
  case "$1" in
    *lanczos_denoise*)          echo "47 42 44.6" ;;
    *lanczos_stab*)             echo "30 24 18.8" ;;
    *lanczos*)                  echo "45 40 39.7" ;;
    *animevideov3*|*nomos8k*)   echo "42 38 36.6" ;;
    *realcugan*|*span*)         echo "43 39 39.7" ;;
    *anime4k*)                  echo "42 38 38.1" ;;
    *rife*)                     echo "38 32 -" ;;
    *swiftvr*)                  echo "38 32 33.5" ;;
    *seedvr2*)                  echo "38 32 35.2" ;;
    *)                          echo "38 32 -" ;;
  esac
}

abspath() { (cd "$(dirname "$1")" && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }

probe() { "$FFPROBE" -v error -count_frames -select_streams v:0 -show_entries stream=width,height,nb_read_frames -of csv=p=0 "$1" 2>/dev/null; }

cmp_one() {
  local mac ref name info_m info_r tmpd verdict
  mac=$(abspath "$1"); ref=$(abspath "$2")
  name=$(basename "$mac")
  info_m=$(probe "$mac"); info_r=$(probe "$ref")
  if [ "$info_m" != "$info_r" ]; then
    printf '%-28s FAIL  尺寸/帧数不一致：Mac %s，参考 %s\n' "$name" "$info_m" "$info_r"; return 1
  fi
  tmpd=$(mktemp -d)
  # stats_file 用相对路径：绝对路径里的特殊字符会被滤镜参数解析器误读
  (cd "$tmpd" && "$FFMPEG" -v error -i "$mac" -i "$ref" -lavfi "[0][1]psnr=stats_file=psnr.txt" -f null - ) || {
    printf '%-28s FAIL  ffmpeg psnr 失败\n' "$name"; rm -rf "$tmpd"; return 1; }
  set -- $(thresholds "$name")
  verdict=$(awk -v lo_avg="$1" -v lo_min="$2" -v wrong="$3" '
    { for (i = 1; i <= NF; i++) if ($i ~ /^psnr_avg:/) { split($i, a, ":"); v = a[2]
        if (v == "inf") { inf++ } else { v += 0; s += v; n++; if (n == 1 || v < m) { m = v; mf = NR } } } }
    END {
      if (!n) { printf "PASS  全部 %d 帧逐位相同", inf; exit }
      avg = s / n
      pass = (avg >= lo_avg && m >= lo_min) ? "PASS" : "FAIL"
      printf "%s  平均 %.2f dB，最低 %.2f dB（第 %d 帧），逐位相同 %d 帧，共 %d 帧；阈值 平均≥%s 单帧≥%s（错误结果约 %s dB）", pass, avg, m, mf, inf, n + inf, lo_avg, lo_min, wrong
    }' "$tmpd/psnr.txt")
  rm -rf "$tmpd"
  printf '%-28s %s\n' "$name" "$verdict"
  case "$verdict" in PASS*) return 0;; *) return 1;; esac
}

if [ "${1:-}" = "--all" ]; then
  DIR="${2:?用法：compare.sh --all <Mac 输出目录>}"
  REF="$ROOT/testdata/reference-windows"
  fails=0; count=0
  for f in "$DIR"/*.mp4; do
    [ -e "$f" ] || continue
    r="$REF/$(basename "$f")"
    if [ -f "$r" ]; then count=$((count + 1)); cmp_one "$f" "$r" || fails=$((fails + 1))
    else printf '%-28s 跳过：参考集中没有同名文件\n' "$(basename "$f")"; fi
  done
  echo "共比较 $count 个，失败 $fails 个"
  [ "$fails" -eq 0 ]
else
  [ $# -eq 2 ] || { sed -n '2,5p' "$0"; exit 2; }
  cmp_one "$1" "$2"
fi
