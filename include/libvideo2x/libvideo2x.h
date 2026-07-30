#pragma once

#include <atomic>
#include <cstdint>
#include <memory>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include "avutils.h"
#include "decoder.h"
#include "encoder.h"
#include "filter_chain.h"
#include "libvideo2x_export.h"
#include "processor.h"

namespace video2x {

enum class VideoProcessorState {
    Idle,
    Running,
    Paused,
    Failed,
    Aborted,
    Completed
};

class LIBVIDEO2X_API VideoProcessor {
   public:
    VideoProcessor(
        const std::vector<processors::ProcessorConfig> proc_cfgs,
        const encoder::EncoderConfig enc_cfg,
        const uint32_t vk_device_idx = 0,
        const AVHWDeviceType hw_device_type = AV_HWDEVICE_TYPE_NONE,
        const bool benchmark = false
    );

    // Backwards-compatible single-processor constructor (deprecated for new code)
    VideoProcessor(
        const processors::ProcessorConfig proc_cfg,
        const encoder::EncoderConfig enc_cfg,
        const uint32_t vk_device_idx = 0,
        const AVHWDeviceType hw_device_type = AV_HWDEVICE_TYPE_NONE,
        const bool benchmark = false
    ) : VideoProcessor(
            std::vector<processors::ProcessorConfig>{proc_cfg},
            enc_cfg,
            vk_device_idx,
            hw_device_type,
            benchmark
        ) {}

    virtual ~VideoProcessor() = default;

    [[nodiscard]] int
    process(const std::filesystem::path in_fname, const std::filesystem::path out_fname);

    void pause() { state_.store(VideoProcessorState::Paused); }
    void resume() { state_.store(VideoProcessorState::Running); }
    void abort() { state_.store(VideoProcessorState::Aborted); }

    VideoProcessorState get_state() const { return state_.load(); }
    int64_t get_processed_frames() const { return frame_idx_.load(); }
    int64_t get_total_frames() const { return total_frames_.load(); }

   private:
    [[nodiscard]] int process_frames(
        decoder::Decoder& decoder,
        encoder::Encoder& encoder,
        processors::FilterChain& filter_chain
    );

    [[nodiscard]] int write_frame(AVFrame* frame, encoder::Encoder& encoder);

    [[nodiscard]] inline int write_raw_packet(
        AVPacket* packet,
        AVFormatContext* ifmt_ctx,
        AVFormatContext* ofmt_ctx,
        int* stream_map
    );

    [[nodiscard]] inline int process_filtering(
        processors::FilterChain& filter_chain,
        encoder::Encoder& encoder,
        AVFrame* frame,
        AVFrame* proc_frame
    );

    // Filters the raw input frame through the pre-interp stages and feeds the
    // result to interpolate_and_write. Takes ownership of nothing; frame stays
    // owned by the caller.
    [[nodiscard]] inline int process_interpolation(
        processors::FilterChain& filter_chain,
        encoder::Encoder& encoder,
        std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_frame,
        std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_raw_frame,
        AVFrame* frame,
        AVFrame* proc_frame
    );

    // Core interpolation + write routine operating on an already pre-filtered
    // frame. Every emitted frame (interpolated and original) passes through the
    // post-interp stages before encoding. Takes ownership of filtered_frame.
    // raw_frame (optional) is used for scene-cut detection on unprocessed frames.
    [[nodiscard]] int interpolate_and_write(
        processors::FilterChain& filter_chain,
        encoder::Encoder& encoder,
        std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_frame,
        std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_raw_frame,
        AVFrame* filtered_frame,
        AVFrame* raw_frame
    );

    // Runs one frame through the post-interp stages (if any) and writes it.
    // Takes ownership of frame.
    [[nodiscard]] int write_frame_through_post(
        processors::FilterChain& filter_chain,
        encoder::Encoder& encoder,
        AVFrame* frame
    );

    std::vector<processors::ProcessorConfig> proc_cfgs_;
    encoder::EncoderConfig enc_cfg_;
    uint32_t vk_device_idx_ = 0;
    AVHWDeviceType hw_device_type_ = AV_HWDEVICE_TYPE_NONE;
    bool benchmark_ = false;

    std::atomic<VideoProcessorState> state_ = VideoProcessorState::Idle;
    // Input-side progress counter (frames read from the decoder)
    std::atomic<int64_t> frame_idx_ = 0;
    // Output-side counter (frames actually written); used for output PTS
    std::atomic<int64_t> out_frame_idx_ = 0;
    std::atomic<int64_t> total_frames_ = 0;
};

}  // namespace video2x
