#pragma once

#include <cstdint>
#include <string>

#include "processor.h"

extern "C" {
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
}

namespace video2x {
namespace processors {

// SDR -> HDR inverse tone mapping stage based on FFmpeg's vf_libplacebo.
// Converts BT.709 SDR input to BT.2020 10-bit HDR (PQ or HLG) output frames.
class FilterHDR : public Filter {
   public:
    FilterHDR(std::string format, int target_peak, uint32_t vk_device_index);
    ~FilterHDR() override;

    int init(AVCodecContext* dec_ctx, AVCodecContext* enc_ctx, AVBufferRef* hw_ctx) override;
    int filter(AVFrame* in_frame, AVFrame** out_frame) override;
    int flush(std::vector<AVFrame*>& flushed_frames) override;

    ProcessorType get_processor_type() const override { return ProcessorType::HDR; }
    FrameDomain get_input_domain() const override { return FrameDomain::Vulkan; }
    FrameDomain get_output_domain() const override { return FrameDomain::Cpu; }

    void get_output_dimensions(
        const ProcessorConfig& proc_cfg,
        int in_width,
        int in_height,
        int& width,
        int& height
    ) const override;

   private:
    // Builds the filter graph lazily on the first frame so the buffer source
    // matches the actual incoming frame parameters (size, format, time base),
    // which depend on the upstream chain stages.
    int build_graph(const AVFrame* ref_frame);
    void cleanup();

    std::string format_;  // "pq" or "hlg"
    int target_peak_ = 1000;
    uint32_t vk_device_index_ = 0;

    AVFilterGraph* filter_graph_ = nullptr;
    AVFilterContext* src_ctx_ = nullptr;
    AVFilterContext* sink_ctx_ = nullptr;
    bool initialized_ = false;

    AVRational in_time_base_ = {0, 1};
    AVRational out_time_base_ = {0, 1};
    AVRational frame_rate_ = {0, 1};
};

}  // namespace processors
}  // namespace video2x
