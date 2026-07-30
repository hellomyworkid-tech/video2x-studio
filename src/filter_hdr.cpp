#include "filter_hdr.h"

#include <cctype>

#include <spdlog/spdlog.h>

extern "C" {
#include <libavutil/opt.h>
}

#include "logger_manager.h"

namespace video2x {
namespace processors {

FilterHDR::FilterHDR(std::string format, int target_peak, uint32_t vk_device_index)
    : format_(std::move(format)), target_peak_(target_peak), vk_device_index_(vk_device_index) {
    // Normalize the transfer format name
    for (auto& c : format_) {
        c = static_cast<char>(std::tolower(c));
    }
    if (format_ != "pq" && format_ != "hlg") {
        logger()->warn("Unknown HDR format '{}', falling back to 'pq'", format_);
        format_ = "pq";
    }
}

FilterHDR::~FilterHDR() {
    cleanup();
}

void FilterHDR::cleanup() {
    if (filter_graph_) {
        avfilter_graph_free(&filter_graph_);
        filter_graph_ = nullptr;
    }
    src_ctx_ = nullptr;
    sink_ctx_ = nullptr;
    initialized_ = false;
}

int FilterHDR::init(AVCodecContext* dec_ctx, AVCodecContext* enc_ctx, AVBufferRef*) {
    in_time_base_ = dec_ctx->time_base;
    out_time_base_ = enc_ctx->time_base;
    if (in_time_base_.num <= 0 || in_time_base_.den <= 0) {
        in_time_base_ = {1, 1000};
    }

    // libplacebo validates that the input link carries a known frame rate
    // (vsync_duration > 0); fall back to 25 fps when the decoder reports none.
    frame_rate_ = dec_ctx->framerate;
    if (frame_rate_.num <= 0 || frame_rate_.den <= 0) {
        frame_rate_ = {25, 1};
        logger()->warn("HDR: decoder reported no frame rate; assuming 25 fps");
    }

    // Verify that the FFmpeg build provides the libplacebo filter
    if (!avfilter_get_by_name("libplacebo")) {
        logger()->critical(
            "The 'libplacebo' filter is not available in this FFmpeg build; "
            "SDR-to-HDR conversion requires FFmpeg built with libplacebo support"
        );
        return -1;
    }
    return 0;
}

int FilterHDR::build_graph(const AVFrame* ref_frame) {
    cleanup();

    char errbuf[AV_ERROR_MAX_STRING_SIZE];

    // Create the Vulkan hardware device context for the libplacebo filter
    AVBufferRef* vk_hw_device_ctx = nullptr;
    int ret = av_hwdevice_ctx_create(
        &vk_hw_device_ctx, AV_HWDEVICE_TYPE_VULKAN, std::to_string(vk_device_index_).c_str(),
        nullptr, 0
    );
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to create Vulkan device for HDR filter: {}", errbuf);
        return ret;
    }

    filter_graph_ = avfilter_graph_alloc();
    if (!filter_graph_) {
        av_buffer_unref(&vk_hw_device_ctx);
        logger()->error("Failed to allocate HDR filter graph");
        return AVERROR(ENOMEM);
    }

    // Buffer source
    const AVFilter* buffer_src = avfilter_get_by_name("buffer");
    const AVFilter* buffer_sink = avfilter_get_by_name("buffersink");

    AVRational tb = in_time_base_;
    if (ref_frame->time_base.num > 0 && ref_frame->time_base.den > 0) {
        tb = ref_frame->time_base;
    }

    char args[512];
    snprintf(
        args, sizeof(args),
        "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:frame_rate=%d/%d:pixel_aspect=%d/%d",
        ref_frame->width, ref_frame->height, ref_frame->format, tb.num, tb.den,
        frame_rate_.num, frame_rate_.den,
        ref_frame->sample_aspect_ratio.num, ref_frame->sample_aspect_ratio.den
    );

    ret = avfilter_graph_create_filter(&src_ctx_, buffer_src, "in", args, nullptr, filter_graph_);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: failed to create buffer src: {}", errbuf);
        avfilter_graph_free(&filter_graph_);
        av_buffer_unref(&vk_hw_device_ctx);
        return ret;
    }

    // If the incoming frames are hardware frames, hand their frames context to the source
    if (ref_frame->hw_frames_ctx != nullptr) {
        AVBufferSrcParameters* src_params = av_buffersrc_parameters_alloc();
        if (src_params) {
            src_params->format = ref_frame->format;
            src_params->width = ref_frame->width;
            src_params->height = ref_frame->height;
            src_params->sample_aspect_ratio = ref_frame->sample_aspect_ratio;
            src_params->time_base = tb;
            src_params->frame_rate = {0, 1};
            src_params->hw_frames_ctx = av_buffer_ref(ref_frame->hw_frames_ctx);
            av_buffersrc_parameters_set(src_ctx_, src_params);
            av_free(src_params);
        }
    }

    // libplacebo filter configured for inverse tone mapping (SDR -> HDR)
    const AVFilter* libplacebo_filter = avfilter_get_by_name("libplacebo");

    // Capability-probe the linked FFmpeg's libplacebo filter options. Older FFmpeg builds
    // (e.g. 7.1) lack `target_peak`; only append options the build actually supports.
    // NOTE: av_opt_find dereferences its first argument, so pass a pointer TO the AVClass
    // pointer (same pattern as init_libplacebo), never the AVClass pointer itself.
    const AVClass* lp_priv_class = libplacebo_filter != nullptr ? libplacebo_filter->priv_class : nullptr;
    bool has_inverse_tonemapping =
        lp_priv_class != nullptr &&
        av_opt_find(&lp_priv_class, "inverse_tonemapping", nullptr, 0, AV_OPT_SEARCH_FAKE_OBJ) !=
            nullptr;
    bool has_target_peak =
        lp_priv_class != nullptr &&
        av_opt_find(&lp_priv_class, "target_peak", nullptr, 0, AV_OPT_SEARCH_FAKE_OBJ) != nullptr;

    if (!has_inverse_tonemapping) {
        logger()->error(
            "HDR: this FFmpeg build does not support inverse tone mapping "
            "(requires libplacebo >= 6.338, FFmpeg >= 6.1)"
        );
        avfilter_graph_free(&filter_graph_);
        av_buffer_unref(&vk_hw_device_ctx);
        return AVERROR(ENOTSUP);
    }

    std::string trc = (format_ == "hlg") ? "hlg" : "smpte2084";
    std::string lp_args =
        "w=" + std::to_string(ref_frame->width) + ":h=" + std::to_string(ref_frame->height) +
        ":format=p010le:colorspace=bt2020nc:color_primaries=bt2020:color_trc=" + trc +
        ":range=limited:inverse_tonemapping=1:gamut_mode=perceptual:dithering=blue";
    if (has_target_peak) {
        lp_args += ":target_peak=" + std::to_string(target_peak_);
    } else {
        logger()->warn(
            "HDR: FFmpeg libplacebo filter lacks 'target_peak' option (FFmpeg < 8.0); "
            "peak luminance will be controlled only via container mastering-display metadata"
        );
    }

    AVFilterContext* libplacebo_ctx = nullptr;
    ret = avfilter_graph_create_filter(
        &libplacebo_ctx, libplacebo_filter, "libplacebo", lp_args.c_str(), nullptr, filter_graph_
    );
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error(
            "HDR: failed to create libplacebo filter ({}). Your FFmpeg/libplacebo build may not "
            "support inverse tone mapping (requires libplacebo >= 6.338, FFmpeg >= 6.1).",
            errbuf
        );
        avfilter_graph_free(&filter_graph_);
        av_buffer_unref(&vk_hw_device_ctx);
        return ret;
    }
    libplacebo_ctx->hw_device_ctx = av_buffer_ref(vk_hw_device_ctx);
    av_buffer_unref(&vk_hw_device_ctx);

    // NOTE: no explicit hwdownload stage. The libplacebo filter declares both Vulkan and
    // software (user-requested `format`) outputs; linking it straight to the buffersink
    // negotiates the software p010le output and lets libplacebo perform the GPU->CPU
    // download internally. This is the same code path the project's FilterLibplacebo
    // uses successfully, and avoids the non-renderable Vulkan frame-pool failure that an
    // explicit hwdownload stage triggers with this FFmpeg/libplacebo build.
    ret = avfilter_graph_create_filter(&sink_ctx_, buffer_sink, "out", nullptr, nullptr, filter_graph_);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: failed to create buffer sink: {}", errbuf);
        avfilter_graph_free(&filter_graph_);
        return ret;
    }

    // Link: buffer -> libplacebo -> sink
    if ((ret = avfilter_link(src_ctx_, 0, libplacebo_ctx, 0)) < 0 ||
        (ret = avfilter_link(libplacebo_ctx, 0, sink_ctx_, 0)) < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: failed to link filter graph: {}", errbuf);
        avfilter_graph_free(&filter_graph_);
        return ret;
    }

    ret = avfilter_graph_config(filter_graph_, nullptr);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: failed to configure filter graph: {}", errbuf);
        avfilter_graph_free(&filter_graph_);
        return ret;
    }

    initialized_ = true;
    logger()->info(
        "HDR filter initialized: SDR -> HDR ({}), target peak {} nits, output BT.2020/{} 10-bit",
        format_ == "hlg" ? "HLG" : "PQ", target_peak_, trc
    );
    return 0;
}

int FilterHDR::filter(AVFrame* in_frame, AVFrame** out_frame) {
    *out_frame = nullptr;

    if (!initialized_) {
        int ret = build_graph(in_frame);
        if (ret < 0) {
            return ret;
        }
    }

    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = av_buffersrc_add_frame_flags(src_ctx_, in_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: error feeding filter graph: {}", errbuf);
        return ret;
    }

    AVFrame* res_frame = av_frame_alloc();
    ret = av_buffersink_get_frame(sink_ctx_, res_frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        av_frame_free(&res_frame);
        return 0;
    } else if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("HDR: error getting frame from filter graph: {}", errbuf);
        av_frame_free(&res_frame);
        return ret;
    }

    if (res_frame->pts != AV_NOPTS_VALUE && out_time_base_.num > 0 && out_time_base_.den > 0) {
        res_frame->pts = av_rescale_q(res_frame->pts, in_time_base_, out_time_base_);
    }

    *out_frame = res_frame;
    return 0;
}

int FilterHDR::flush(std::vector<AVFrame*>& flushed_frames) {
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
        flushed_frames.push_back(res_frame);
    }
    return 0;
}

void FilterHDR::get_output_dimensions(
    const ProcessorConfig& proc_cfg,
    int in_width,
    int in_height,
    int& width,
    int& height
) const {
    width = proc_cfg.width > 0 ? proc_cfg.width : in_width;
    height = proc_cfg.height > 0 ? proc_cfg.height : in_height;
}

}  // namespace processors
}  // namespace video2x
