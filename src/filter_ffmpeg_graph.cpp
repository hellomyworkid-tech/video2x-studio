#include "filter_ffmpeg_graph.h"

#include <spdlog/spdlog.h>

#include "avutils.h"
#include "logger_manager.h"

namespace video2x {
namespace processors {

FilterFFmpegGraph::FilterFFmpegGraph(std::string graph_desc)
    : graph_desc_(std::move(graph_desc)) {}

FilterFFmpegGraph::~FilterFFmpegGraph() {
    cleanup();
}

void FilterFFmpegGraph::cleanup() {
    if (filter_graph_) {
        avfilter_graph_free(&filter_graph_);
        filter_graph_ = nullptr;
    }
    src_ctx_ = nullptr;
    sink_ctx_ = nullptr;
    initialized_ = false;
    graph_width_ = 0;
    graph_height_ = 0;
    graph_pix_fmt_ = -1;
}

int FilterFFmpegGraph::init(AVCodecContext* dec_ctx, AVCodecContext* enc_ctx, AVBufferRef*) {
    if (graph_desc_.empty()) {
        logger()->error("FFmpeg graph description is empty");
        return -1;
    }

    // Store time bases for PTS rescaling; the graph itself is built lazily on
    // the first frame so it matches the actual incoming frame parameters.
    in_time_base_ = dec_ctx->time_base;
    out_time_base_ = enc_ctx->time_base;
    if (in_time_base_.num <= 0 || in_time_base_.den <= 0) {
        in_time_base_ = {1, 1000};
    }
    return 0;
}

int FilterFFmpegGraph::build_graph(const AVFrame* ref_frame) {
    cleanup();

    filter_graph_ = avfilter_graph_alloc();
    if (!filter_graph_) {
        logger()->error("Failed to allocate filter graph");
        return -1;
    }

    const AVFilter* buffer_src = avfilter_get_by_name("buffer");
    const AVFilter* buffer_sink = avfilter_get_by_name("buffersink");

    AVRational tb = in_time_base_;
    if (ref_frame->time_base.num > 0 && ref_frame->time_base.den > 0) {
        tb = ref_frame->time_base;
    }

    char args[512];
    snprintf(
        args,
        sizeof(args),
        "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:pixel_aspect=%d/%d",
        ref_frame->width,
        ref_frame->height,
        ref_frame->format,
        tb.num,
        tb.den,
        ref_frame->sample_aspect_ratio.num,
        ref_frame->sample_aspect_ratio.den
    );

    char errbuf[AV_ERROR_MAX_STRING_SIZE];

    int ret = avfilter_graph_create_filter(&src_ctx_, buffer_src, "in", args, nullptr, filter_graph_);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to create buffer src filter: {}", errbuf);
        cleanup();
        return ret;
    }

    ret = avfilter_graph_create_filter(&sink_ctx_, buffer_sink, "out", nullptr, nullptr, filter_graph_);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to create buffer sink filter: {}", errbuf);
        cleanup();
        return ret;
    }

    AVFilterInOut* outputs = avfilter_inout_alloc();
    AVFilterInOut* inputs = avfilter_inout_alloc();

    outputs->name = av_strdup("in");
    outputs->filter_ctx = src_ctx_;
    outputs->pad_idx = 0;
    outputs->next = nullptr;

    inputs->name = av_strdup("out");
    inputs->filter_ctx = sink_ctx_;
    inputs->pad_idx = 0;
    inputs->next = nullptr;

    ret = avfilter_graph_parse_ptr(filter_graph_, graph_desc_.c_str(), &inputs, &outputs, nullptr);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);

    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to parse filter graph '{}': {}", graph_desc_, errbuf);
        cleanup();
        return ret;
    }

    ret = avfilter_graph_config(filter_graph_, nullptr);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to configure filter graph '{}': {}", graph_desc_, errbuf);
        cleanup();
        return ret;
    }

    graph_width_ = ref_frame->width;
    graph_height_ = ref_frame->height;
    graph_pix_fmt_ = ref_frame->format;
    initialized_ = true;
    logger()->info(
        "FFmpeg filter graph initialized: {} ({}x{}, fmt={})", graph_desc_, graph_width_,
        graph_height_, graph_pix_fmt_
    );
    return 0;
}

int FilterFFmpegGraph::filter(AVFrame* in_frame, AVFrame** out_frame) {
    *out_frame = nullptr;

    // CPU filters cannot consume hardware frames; download to software first
    AVFrame* sw_frame = nullptr;
    if (in_frame->hw_frames_ctx != nullptr) {
        sw_frame = av_frame_alloc();
        if (sw_frame == nullptr) {
            return AVERROR(ENOMEM);
        }
        int ret = av_hwframe_transfer_data(sw_frame, in_frame, 0);
        if (ret < 0) {
            char errbuf[AV_ERROR_MAX_STRING_SIZE];
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->error("Failed to download hardware frame for FFmpeg graph: {}", errbuf);
            av_frame_free(&sw_frame);
            return ret;
        }
        sw_frame->pts = in_frame->pts;
        in_frame = sw_frame;
    }

    // Lazy (re)build if the incoming frame parameters changed
    if (!initialized_ || in_frame->width != graph_width_ || in_frame->height != graph_height_ ||
        in_frame->format != graph_pix_fmt_) {
        if (initialized_) {
            logger()->warn(
                "FFmpeg graph input parameters changed ({}x{} fmt={} -> {}x{} fmt={}); rebuilding",
                graph_width_, graph_height_, graph_pix_fmt_, in_frame->width, in_frame->height,
                in_frame->format
            );
        }
        int ret = build_graph(in_frame);
        if (ret < 0) {
            av_frame_free(&sw_frame);
            return ret;
        }
    }

    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = av_buffersrc_add_frame_flags(src_ctx_, in_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    av_frame_free(&sw_frame);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Error adding frame to filter graph: {}", errbuf);
        return ret;
    }

    AVFrame* res_frame = av_frame_alloc();
    ret = av_buffersink_get_frame(sink_ctx_, res_frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        // The filter buffered the frame (e.g. vidstabtransform's smoothing window)
        av_frame_free(&res_frame);
        return 0;
    } else if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Error getting frame from filter graph: {}", errbuf);
        av_frame_free(&res_frame);
        return ret;
    }

    // Rescale PTS to the encoder's time base
    if (res_frame->pts != AV_NOPTS_VALUE && out_time_base_.num > 0 && out_time_base_.den > 0) {
        res_frame->pts = av_rescale_q(res_frame->pts, in_time_base_, out_time_base_);
    }

    *out_frame = res_frame;
    return 0;
}

int FilterFFmpegGraph::flush(std::vector<AVFrame*>& out_frames) {
    if (!initialized_) {
        return 0;
    }

    int ret = av_buffersrc_add_frame_flags(src_ctx_, nullptr, 0);
    if (ret < 0) {
        return ret;
    }

    while (true) {
        AVFrame* res_frame = av_frame_alloc();
        ret = av_buffersink_get_frame(sink_ctx_, res_frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF || ret < 0) {
            av_frame_free(&res_frame);
            break;
        }

        if (res_frame->pts != AV_NOPTS_VALUE && out_time_base_.num > 0 && out_time_base_.den > 0) {
            res_frame->pts = av_rescale_q(res_frame->pts, in_time_base_, out_time_base_);
        }
        out_frames.push_back(res_frame);
    }

    return 0;
}

void FilterFFmpegGraph::get_output_dimensions(
    const ProcessorConfig& proc_cfg,
    int in_width,
    int in_height,
    int& width,
    int& height
) const {
    if (proc_cfg.width > 0 && proc_cfg.height > 0) {
        width = proc_cfg.width;
        height = proc_cfg.height;
    } else if (proc_cfg.scaling_factor > 0) {
        // Rescaling graph (e.g. lanczos) expressed as a scale factor
        width = in_width * proc_cfg.scaling_factor;
        height = in_height * proc_cfg.scaling_factor;
    } else {
        width = in_width;
        height = in_height;
    }
}

}  // namespace processors
}  // namespace video2x
