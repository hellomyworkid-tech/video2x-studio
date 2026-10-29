# Video2X Studio — 给 Claude Code 的项目说明

## 当前状态

- Windows 版完整可用并已打包。
- macOS（Apple Silicon）移植的阶段 0–6 已完成，`cd ui && npm run dist:mac` 产出 `.app`；还要人工确认的项目是 `docs/macos/05-acceptance.md` 里没勾选的条目。
- 两个平台都要继续可用：改动走平台分支，bridge 的平台差异收在 `ui/server/platform.mjs`；改完按 `docs/macos/05-acceptance.md` 的方法回归。

## 项目是什么

基于开源 Video2X 6.x（AGPL-3.0）改造的视频超分/修复桌面应用，面向小型工作室批量处理短剧素材。四层结构：

| 层 | 位置 | 说明 |
|---|---|---|
| 桌面外壳 | `ui/electron/` | Electron 主进程。启动时加载 bridge，然后打开窗口 |
| 本地服务 | `ui/server/bridge.mjs` | Node HTTP + SSE 服务，监听 127.0.0.1:7199。负责任务队列、按物理 GPU 调度、权重下载、预检，并 spawn 下面两类引擎 |
| C++ 核心 | `src/`、`include/`、`tools/video2x/` | `libvideo2x` + `video2x` CLI：FFmpeg 解码编码，ncnn/Vulkan 推理（Real-ESRGAN / Real-CUGAN / RIFE / SPAN），libplacebo（Anime4K），Lanczos，防抖 / 降噪 / HDR 增强 |
| PyTorch 引擎 | `engine-python/` | `worker.py` 入口，三个引擎：RealBasicVSR、SeedVR2-3B（`vendor/seedvr2`）、SwiftVR（`vendor/swiftvr`）。断点续跑、宏分片、音轨/字幕回填 |
| 前端 | `ui/src/` | React + Vite + Tailwind；`lib/args.ts` 负责把表单转成引擎参数 |

不在 git 里、要单独准备的东西：

- `third_party/`：FFmpeg、ncnn、三个 ncnn 封装库的源码
- `models/`：ncnn 模型
- `engine-python/weights/`：PyTorch 权重
- `engine-python/python/`（嵌入式 Python）、`engine-python/swiftvr-libs/`
- `testdata/`：测试素材与参考输出

macOS 上这些都由迁移包的 `restore-on-mac.sh` 恢复，详见 `docs/macos/03-setup.md`。

## 常用命令

| 用途 | Windows | macOS（移植中，命令以 docs/macos 为准） |
|---|---|---|
| 编译 C++ 核心 | `build_video2x.ps1`（产物在 `build-desktop/Release/`） | `bash scripts/macos/build-core.sh`（产物在 `build-macos/`） |
| 开发模式 | `cd ui && npm run dev`（bridge + vite） | 同左 |
| 桌面窗口 | `cd ui && npm run desktop` | 同左 |
| 打包 | `cd ui && npm run dist`（含 check-dist 前后检查；国内用 npmmirror 的 Electron 镜像） | 待新增 `dist:mac` |
| Python 单测 | `engine-python/python/python.exe engine-python/tests/test_resolve_device.py` | `engine-python/.venv/bin/python engine-python/tests/test_resolve_device.py` |
| 类型检查 | `cd ui && npx tsc --noEmit -p .` | 同左 |
| 环境体检 | — | `bash scripts/macos/doctor.sh` |
| 与 Windows 参考输出对比 | — | `bash scripts/macos/compare.sh --all testdata/mac` |
| 端到端冒烟 | `BRIDGE_PORT=7299 node ui/server/bridge.mjs` + `node scripts/macos/smoke-bridge.mjs …` | 同左（`DEVICE` 自动取 `mps`） |

## 必须遵守

1. **Windows 版不能被移植改坏。** 平台差异走分支（`process.platform`、`sys.platform`、`#ifdef __APPLE__`），bridge 里的差异集中到 `ui/server/platform.mjs`。
2. **进程间协议不改语义。** 这些约定的细节见 `docs/macos/04-knowledge-handoff.md` §2：
   - 进度行格式
   - worker 退出码 0 / 1 / 3 / 4
   - 旗标文件 `.v2xpause` / `.v2xsuspended`
   - 检查点 `.v2xckpt.json` 与宏分片 `.segNNNNNN.mp4`
3. **核心不变量。** 下面每一条都是修过的 bug，改相关代码前先读 04 文档 §3：
   - 编码器是 PTS 的唯一负责者，默认保留源时间戳（VFR）
   - Python 引擎 BT.709 + 色彩标签
   - VFR 解码按平均帧率重采样
   - 码率与 CRF 互斥
   - Vulkan 与 CUDA/MPS 是不同的设备编号空间
   - 输出去重要包含正在运行的任务
4. **结论来自实测。** 速度看稳态（扣掉启动开销），画质看 PSNR（`inf` 单独计数）。没测过的就写"待实测"，不要沿用 Windows 数据。
5. **不留孤儿进程。** 跑完 GPU 任务后确认没有残留：Windows 用 `tasklist`，macOS 用 `pgrep -fl "worker.py|video2x|ffmpeg"`。冒烟测试用独立端口（7299）的 bridge，测完关掉。
6. **改了引擎或打包相关内容，要提交给用户实测。** 用户习惯"改完打包给我测试"。诊断问题时如果用户说"不要改代码"，就只给结论。
7. **提交。** 中文提交说明，按相对独立的改动分别提交，结尾带 Co-Authored-By 行。

## 沟通

- 用户用中文交流，回复用中文。
- 用户是工作室负责人，关心真实可用性和量化数据；负面结论要如实说明并给出原因。

## 文档地图

- `docs/macos/`：macOS 移植全套资料（可行性、Windows 专有代码清单、环境搭建、知识交接、验收）
- `docs/reports/`：历次代码审查、性能与选型分析、SeedVR2 集成方案、短剧素材选型实测
- `CHANGELOG.md`：本分支相对上游 Video2X 的全部变更
- `COMPLIANCE.md`、`NOTICE`、`WEIGHTS_LICENSES.md`：许可与合规（`spynet.pth` 为非商业许可，商用分发要删除）
