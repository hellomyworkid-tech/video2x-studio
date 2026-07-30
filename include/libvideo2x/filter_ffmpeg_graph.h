#pragma once

#include <string>

#include "processor.h"

extern "C" {
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
}

namespace video2x {
namespace processors {

class FilterFFmpegGraph : public Filter {
   public:
    explicit FilterFFmpegGraph(std::string graph_desc);
    ~FilterFFmpegGraph() override;

    int init(AVCodecContext* dec_ctx, AVCodecContext* enc_ctx, AVBufferRef* hw_ctx) override;
    int filter(AVFrame* in_frame, AVFrame** out_frame) override;
    int flush(std::vector<AVFrame*>& out_frames) override;

    ProcessorType get_processor_type() const override { return ProcessorType::FFmpegGraph; }
    FrameDomain get_input_domain() const override { return FrameDomain::Cpu; }
    FrameDomain get_output_domain() const override { return FrameDomain::Cpu; }

    void get_output_dimensions(
        const ProcessorConfig& proc_cfg,
        int in_width,
        int in_height,
        int& width,
        int& height
    ) const override;

   private:
    // (Re)builds the filter graph for the given frame parameters. The graph is
    // built lazily on the first frame and rebuilt if the incoming frame's size
    // or pixel format changes, so the stage can sit anywhere in a filter chain
    // (e.g. after a super-resolution stage that changed the frame dimensions).
    int build_graph(const AVFrame* ref_frame);
    void cleanup();

    std::string graph_desc_;
    AVFilterGraph* filter_graph_ = nullptr;
    AVFilterContext* src_ctx_ = nullptr;
    AVFilterContext* sink_ctx_ = nullptr;
    bool initialized_ = false;

    // Frame parameters the current graph was built for
    int graph_width_ = 0;
    int graph_height_ = 0;
    int graph_pix_fmt_ = -1;

    // Time bases for PTS rescaling (input side -> encoder side)
    AVRational in_time_base_ = {0, 1};
    AVRational out_time_base_ = {0, 1};
};

}  // namespace processors
}  // namespace video2x
