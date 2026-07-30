# Video2X Studio

Video2X 的现代桌面级 Web 控制台：批量视频超分、补帧、防抖、降噪与 SDR→HDR 转制。

## 启动

```bash
cd ui
npm run dev          # 同时启动界面(Vite)与本地桥接服务，浏览器打开提示的地址
npm run dev -- --port 7100   # 指定端口
```

> 需先完成主项目构建（`build-desktop/Release/video2x.exe` 存在）。
> 桥接服务默认端口 7199，可用 `set BRIDGE_PORT=xxxx` 覆盖；
> CLI 路径可用 `set VIDEO2X_CLI=D:\path\to\video2x.exe` 覆盖。

## 功能

- **任务队列**：批量串行处理（保障 GPU 稳定），实时进度 / FPS / 剩余时间，日志尾部查看，中止 / 删除 / 一键清理
- **新建任务**：一次配置批量应用到多个视频
  - 输入输出：原生多选文件对话框、输出目录、容器与命名模板 `{name}_v2x.{ext}`
  - 处理器：libplacebo（Anime4K）/ Real-ESRGAN / Real-CUGAN / RIFE 补帧 / SPAN，全部模型与子参数
  - 画质增强：防抖（vidstab 两段式）、降噪（hqdn3d / nlmeans）、SDR→HDR（PQ / HLG，自动 libx265 + HDR10 元数据）
  - 编码器：常用编码器预设、CRF、码率、像素格式、音/字幕流复制、自定义 AVOption
  - 高级：Vulkan 设备选择（自动枚举）、解码硬解、日志级别、基准模式
- 底部实时预览生成的完整命令行

## 架构

```
ui/
├── src/            React + TypeScript + Tailwind + shadcn/ui 前端
│   ├── sections/   界面区块（队列 / 新建任务表单）
│   ├── lib/args.ts UI 配置 → video2x CLI 参数构建器（与 --help 严格对齐）
│   └── lib/api.ts  API 客户端 + SSE 实时任务流
└── server/bridge.mjs  本地桥（零依赖 Node）：spawn CLI、进度解析、
                        Windows 原生文件对话框、批量队列、SSE 推送
```
