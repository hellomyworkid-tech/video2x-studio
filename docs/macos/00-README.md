# macOS 移植资料（入口）

这组文档是在 Windows 开发机上整理的，目的是让 **Mac 上的 Claude Code 接手后不用重新摸索**：
项目怎么搭的、哪些地方绑死了 Windows、Mac 上每个组件用什么替代、按什么顺序做、做完怎么验收。

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [01-feasibility.md](01-feasibility.md) | 逐组件可行性、Mac 硬件预期、分阶段路线与关键决策 | 开工前必读 |
| [02-windows-specific-inventory.md](02-windows-specific-inventory.md) | 所有 Windows 专有代码的清单（文件:行号）与 Mac 替代方案 | 改代码时逐条对照 |
| [03-setup.md](03-setup.md) | Mac 开发环境搭建步骤（Homebrew、Python、Node、权重放置） | 第一天 |
| [04-knowledge-handoff.md](04-knowledge-handoff.md) | Windows 阶段积累的架构细节、不变量、踩过的坑、实测数据 | 动任何核心逻辑前 |
| [05-acceptance.md](05-acceptance.md) | 移植验收清单与对比方法（与 Windows 参考输出逐帧比 PSNR） | 每个阶段收尾 |

配套脚本在 `scripts/macos/`：

- `doctor.sh`：只读体检（芯片/内存/系统、Homebrew 依赖、FFmpeg 滤镜、Vulkan/MoltenVK、PyTorch MPS 冒烟、权重是否就位）。
- `bootstrap.sh`：按 03-setup.md 安装依赖、建 Python 虚拟环境、装 npm 依赖（幂等，可重复跑）。
- `compare.sh`：把 Mac 输出与 Windows 参考输出逐帧比 PSNR。

> 这些脚本是在 Windows 上写的，**没有在 Mac 上实际跑过**。第一次运行时请 Claude Code
> 边跑边修，修好后提交。

## 给 Mac 上 Claude Code 的工作约定

1. **Windows 版必须继续可用。** 所有改动走平台分支（`process.platform === 'darwin'`、
   `sys.platform == 'darwin'`、`#ifdef __APPLE__`），不要删 Windows 路径。移植完成后两边各自能打包。
2. **先测再说。** 本项目所有性能、画质结论都来自实测（见 04 文档）。Mac 上的速度、显存（统一内存）
   上限要重新测，不要沿用 Windows 数字。
3. **不留孤儿进程。** 跑完 GPU 任务后用 `pgrep -fl "python|ffmpeg|video2x"` 确认没有残留——
   Windows 阶段出过后台进程吃满内存、让测速结论作废的事故。
4. **逐阶段提交**，每阶段按 05-acceptance.md 验收后再进入下一阶段。
