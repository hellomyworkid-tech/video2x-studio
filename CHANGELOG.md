# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (this branch / 本分支)

- Video2X Studio desktop application (`ui/`, Electron + React): batch queue, pause / resume-at-checkpoint / resume-after-crash with sharded checkpoints, NAS source pre-processing (lossless remux with transcode fallback), automatic model/binary download with mirror fallback, per-GPU CUDA device selection, persistent last-used configuration.
- Two Python VSR engines (`engine-python/`): SeedVR2-3B (target-resolution) and RealBasicVSR (4×), both with pause/stop-at-checkpoint/resume support.
- FilterChain architecture in the C++ core (`src/filter_chain.cpp`): composable filter stages.
- `--denoise` CLI option: FFmpeg-based denoising stage.
- `--stab` CLI option: two-pass video stabilization via vidstabdetect/vidstabtransform (`src/stab_prepass.cpp`).
- `--hdr` CLI option: SDR→HDR tone mapping (`src/filter_hdr.cpp`, libplacebo-based).
- SPAN super-resolution model support via ncnn/Vulkan (`src/filter_span.cpp`).
- Graceful SPyNet degradation: RealBasicVSR falls back to checkpoint-embedded SPyNet keys when `spynet.pth` is absent (enables commercial-compliant builds).
- Multi-GPU scheduling: one serial queue per physical GPU (Vulkan and CUDA indices are mapped to the same card by name), so jobs on different GPUs run in parallel while jobs on the same GPU stay sequential.
- Lanczos processor (`-p lanczos`, CPU-only FFmpeg scaling) as the default processor.
- `{proc}` naming-template token (processor + model, e.g. `esrgan-nomos8k-compact`); default template is now `{name}_{proc}.{ext}`.
- "Auto (discrete first)" Vulkan device selection, now the default.
- Daily log files under `cache/logs/` (kept 7 days) with a status-bar shortcut; job output, exit codes and bridge messages survive restarts.
- Install-integrity check: a red banner lists missing runtime files instead of offering weight downloads that cannot help; the start button explains why it is disabled.
- Packaging guard (`ui/scripts/check-dist.mjs`): `npm run dist` aborts on missing runtime files or C++ binaries older than their sources, and verifies the output package.
- Disk-space precheck for the output drive and the local staging drive.
- SwiftVR engine (one-step streaming generative video restoration, Apache 2.0, Wan2.2-TI2V-5B base). Weight-only FP8 with pre-fused QKV and the unused projection copies dropped keeps the weights at ~5 GB (official bf16: 12 GB), so 2560×1440 output fits 16 GB VRAM; measured ~4 fps end-to-end on an RTX 5070 Ti (≈16× SeedVR2), FP8 vs bf16 output PSNR ≈ 50 dB. Runs in an isolated dependency overlay (`engine-python/swiftvr-libs`: diffusers 0.36 + decord) so SeedVR2's diffusers 0.33 is untouched; shares the checkpoint/resume, colour, VFR and stream-copy pipeline; halves the clip length and retries on OOM.
- PyTorch engines: subtitle stream copy, audio/subtitle copy switches, `--pix-fmt` (e.g. 10-bit), automatic SeedVR2 attention backend (SageAttention/FlashAttention when installed, `V2X_SEEDVR2_ATTN` override).

### Changed (this branch / 本分支)

- Timestamps: source timestamps are preserved by default (frames carry their time base through the chain and the encoder is the single owner of output PTS). `--recalculate-pts` opts into the old index-based constant-frame-rate timeline; `--no-recalculate-pts` is kept as a no-op. The UI toggle became "Force constant frame rate" (off by default).
- Bit rate is entered in Mbps and is mutually exclusive with CRF.
- Explicit output sizes are rounded up to even dimensions.
- Dependencies updated within major versions (Electron 43.7.7, React 19.3, Vite 7.3.6); production `npm audit` is clean.

### Fixed (this branch / 本分支)

- Variable-frame-rate sources lost A/V sync on every ncnn/Lanczos chain (a 60 s clip ended 10 s short) because timestamps were rewritten as frame index ÷ nominal rate.
- RIFE with timestamp recalculation disabled crashed with "non monotonically increasing dts" and left a corrupt file; interpolated frames now sit at their time step between neighbours (exact even on VFR input via a finer encoder time base).
- CLI exited with a segfault (139) instead of 1/2 on failure or abort because the ncnn GPU instance was only torn down on success.
- RealBasicVSR/SeedVR2 output colours were shifted (up to 22/255) — RGB→YUV used BT.601 without colour tags; now BT.709 with tags.
- RealBasicVSR/SeedVR2 jumped every segment and drifted up to 1.66 s on VFR sources; decoding now resamples to the average frame rate.
- Jobs submitted separately with the same output name overwrote each other (and could wipe a paused PyTorch job's checkpoint).
- A configured bit rate was silently ignored whenever a CRF was also set.
- "Open folder" opened Documents for paths containing spaces.
- Downloaded weights were deleted when the Python runtime was missing (verification failure was mistaken for corruption).
- Stabilization rejected frames smaller than 128×128 instead of crashing intermittently inside libvidstab.
- Removed dead code (`temporal_buffer`) and the unused FlashVSR vendor tree.

### Added

- Option to recalculate the PTS.
- Real-ESRGAN models `realesr-general-x4v3` and `realesr-general-wdn-x4v3` (#1319).
- (Video2X Qt6) Korean translation.

### Changed

- Separate audio and subtitle stream copying options.

### Fixed

- Null pointer dereference in Real-ESRGAN, Real-CUGAN, and RIFE processors when frame conversion fails.
- Vulkan hardware device context leak on error paths in libplacebo filter initialization.
- Incorrect spdlog format string using printf-style specifiers instead of fmt-style placeholders.
- Division by zero in CLI progress display within the first second of processing.
- `unhook_ffmpeg_logging` disabling all FFmpeg logging instead of restoring the default callback.

## [6.4.0] - 2025-01-24

### Added

- Multi-versioning to critical functions to enhance performance in generic architecture builds.
- RIFE models `v4.25` and `v4.26` (#1304).
- Support for processing videos without PTS information (#1278).
- The feature to copy input streams' metadata to the output streams (#1282).
- (Video2X Qt6) German translation (#1279).
- (Video2X Qt6) Option to remove finished tasks from the queue.
- (Video2X Qt6) Option to specify actions after processing is complete.
- (Video2X Qt6) Support for adding and removing tasks during processing (#1281).
- (Video2X Qt6) The feature to automatically set codec to PNG for images (#1204).
- (Video2X Qt6) The preferences dialog.

### Changed

- Improve the CMake optimization flags and option names.
- (Video2X Qt6) Embed translation files in the executable to avoid missing resources (#1250).
- (Video2X Qt6) Redesign the main window UI to improve usability.

### Fixed

- A bug that causes the wrong encoder to be selected.
- (Video2X Qt6) Incorrect font used for the Japanese translation (#1276).

## [6.3.1] - 2024-12-21

### Fixed

- The issue of decreasing PTS precision with increasing video duration (#1269).
- (Video2X Qt6) Errors restoring Real-CUGAN configs in the Edit Task dialog.
- (Video2X Qt6) The incorrect comparison of version numbers.

## [6.3.0] - 2024-12-20

### Added

- A logger manager to provide unified logging across the application.
- Support for Real-CUGAN ncnn Vulkan (#1198).
- (Video2X Qt6) A check to ensure the required VC++ Redistributable version is installed.
- (Video2X Qt6) A configuration manager to save user preferences like the last selected language.
- (Video2X Qt6) A new logging widget to display logs in the UI.
- (Video2X Qt6) Custom options `crf=20` and `preset=slow` to the default encoder options.
- (Video2X Qt6) French translation.
- (Video2X Qt6) The ability to check for available updates and prompt the user to update.
- (Video2X Qt6) Tooltips for processor and encoder options.

### Changed

- Improve optimization flags and add namespaces for better code organization.
- (Video2X Qt6) Add processor names to processed videos instead of `.processed`.
- (Video2X Qt6) The output video suffix from auto-generated to `.mkv`.

### Fixed

- Make the encoder always use the calculated PTS with corrected math.
- (Video2X Qt6) The issue where task configs are being restored incorrectly in the UI.

## [6.2.0] - 2024-12-11

### Added

- Automatic selection of the most suitable pixel format for the output video.
- Frame interpolation processing mode.
- More `AVCodecContext` options.
- Support for RIFE ncnn Vulkan.
- Support for specifying arbitrary `AVOptions` for the encoder (#1232).
- (Video2X Qt6) Visual C++ Redistributable version check to the installer.

### Changed

- Improve CLI argument validation.
- Improve error handling and error messages.
- Improve the CLI help message structure and clarity.
- (Video2X Qt6) Improve the UI with a complete redesign.

### Removed

- The C API for easier maintenance and development.

### Fixed

- Timestamp errors processing frames with PTS equal to 0 (#1222).

## [6.1.1] - 2024-11-07

### Added

- Time remaining, and processing speed to the status bar.

### Fixed

- Stream mapping for cases where the video stream is not the first stream in the input file (#1217).
- The encoder using the wrong color space for the output video.

## [6.1.0] - 2024-11-04

### Added

- A better timer that gets paused when the processing is paused.
- Detection for the validity of the provided GPU ID.
- The `--listgpus` option to list available Vulkan GPU devices.
- Vulkan device selection for libplacebo.
- (Video2X Qt6) Status bar and processing statistics.

### Changed

- Automatically detect if options `colorspace` and `range` are supported by the buffer filter.
- Resource file missing error messages.
- Rewritten the CLI with C++.

### Fixed

- Wide character string paths support on Windows systems without UTF-8 support enabled (#1201).

## [6.0.0] - 2024-10-29

### Added

- The initial release of the 6.0.0 version of Video2X.
