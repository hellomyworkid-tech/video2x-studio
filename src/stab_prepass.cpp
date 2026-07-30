#include "stab_prepass.h"

#include <spdlog/spdlog.h>
#include <cstdio>
#include <memory>
#include "avutils.h"
#include "decoder.h"
#include "logger_manager.h"

extern "C" {
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
}

namespace video2x {

int StabilizationPrepass::analyze(
    const std::filesystem::path& input_path,
    const std::filesystem::path& trf_output_path,
    const processors::VidStabConfig& config
) {
    logger()->info("Starting video stabilization analysis pass on: {}", input_path.string());

    decoder::Decoder decoder;
    if (decoder.init(AV_HWDEVICE_TYPE_NONE, nullptr, input_path) != 0) {
        logger()->error("Failed to initialize decoder for stabilization prepass");
        return -1;
    }

    AVFormatContext* fmt_ctx = decoder.get_format_context();
    AVCodecContext* dec_ctx = decoder.get_codec_context();
    int stream_idx = decoder.get_video_stream_index();

    AVFilterGraph* graph = avfilter_graph_alloc();
    if (!graph) {
        logger()->error("Failed to allocate filter graph for vidstabdetect");
        return -1;
    }

    const AVFilter* buffer_src = avfilter_get_by_name("buffer");
    const AVFilter* buffer_sink = avfilter_get_by_name("buffersink");
    AVFilterContext* src_ctx = nullptr;
    AVFilterContext* sink_ctx = nullptr;

    char args[512];
    snprintf(
        args,
        sizeof(args),
        "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:pixel_aspect=%d/%d",
        dec_ctx->width,
        dec_ctx->height,
        dec_ctx->pix_fmt,
        dec_ctx->time_base.num,
        dec_ctx->time_base.den,
        dec_ctx->sample_aspect_ratio.num,
        dec_ctx->sample_aspect_ratio.den
    );

    char errbuf[AV_ERROR_MAX_STRING_SIZE];

    int ret = avfilter_graph_create_filter(&src_ctx, buffer_src, "in", args, nullptr, graph);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to create buffer src for prepass: {}", errbuf);
        avfilter_graph_free(&graph);
        return ret;
    }

    ret = avfilter_graph_create_filter(&sink_ctx, buffer_sink, "out", nullptr, nullptr, graph);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to create buffer sink for prepass: {}", errbuf);
        avfilter_graph_free(&graph);
        return ret;
    }

    // Escape backslashes for windows paths in FFmpeg filter string
    std::string trf_str = trf_output_path.string();
    std::string trf_escaped;
    for (char c : trf_str) {
        if (c == '\\') trf_escaped += "/";
        else if (c == ':') trf_escaped += "\\:";
        else trf_escaped += c;
    }

    char filter_desc[1024];
    snprintf(
        filter_desc,
        sizeof(filter_desc),
        "vidstabdetect=shakiness=%d:result=%s",
        config.shakiness,
        trf_escaped.c_str()
    );

    AVFilterInOut* outputs = avfilter_inout_alloc();
    AVFilterInOut* inputs = avfilter_inout_alloc();

    outputs->name = av_strdup("in");
    outputs->filter_ctx = src_ctx;
    outputs->pad_idx = 0;
    outputs->next = nullptr;

    inputs->name = av_strdup("out");
    inputs->filter_ctx = sink_ctx;
    inputs->pad_idx = 0;
    inputs->next = nullptr;

    ret = avfilter_graph_parse_ptr(graph, filter_desc, &inputs, &outputs, nullptr);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);

    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to parse vidstabdetect graph filter: {}", errbuf);
        avfilter_graph_free(&graph);
        return ret;
    }

    ret = avfilter_graph_config(graph, nullptr);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->error("Failed to configure vidstabdetect filter graph: {}", errbuf);
        avfilter_graph_free(&graph);
        return ret;
    }

    AVPacket* packet = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    int frame_count = 0;

    while (av_read_frame(fmt_ctx, packet) >= 0) {
        if (packet->stream_index == stream_idx) {
            if (avcodec_send_packet(dec_ctx, packet) == 0) {
                while (avcodec_receive_frame(dec_ctx, frame) == 0) {
                    av_buffersrc_add_frame_flags(src_ctx, frame, AV_BUFFERSRC_FLAG_KEEP_REF);
                    av_frame_unref(frame);

                    AVFrame* dummy = av_frame_alloc();
                    while (av_buffersink_get_frame(sink_ctx, dummy) >= 0) {
                        av_frame_unref(dummy);
                    }
                    av_frame_free(&dummy);

                    frame_count++;
                }
            }
        }
        av_packet_unref(packet);
    }

    // Flush the decoder to drain any frames delayed by B-frame reordering
    if (avcodec_send_packet(dec_ctx, nullptr) == 0) {
        while (avcodec_receive_frame(dec_ctx, frame) == 0) {
            av_buffersrc_add_frame_flags(src_ctx, frame, AV_BUFFERSRC_FLAG_KEEP_REF);
            av_frame_unref(frame);

            AVFrame* dummy = av_frame_alloc();
            while (av_buffersink_get_frame(sink_ctx, dummy) >= 0) {
                av_frame_unref(dummy);
            }
            av_frame_free(&dummy);

            frame_count++;
        }
    }

    av_packet_free(&packet);
    av_frame_free(&frame);

    // Flush filter graph
    av_buffersrc_add_frame_flags(src_ctx, nullptr, 0);
    AVFrame* dummy = av_frame_alloc();
    while (av_buffersink_get_frame(sink_ctx, dummy) >= 0) {
        av_frame_unref(dummy);
    }
    av_frame_free(&dummy);

    avfilter_graph_free(&graph);

    // Verify that vidstabdetect actually produced the transforms file
    std::error_code ec;
    if (!std::filesystem::exists(trf_output_path, ec) ||
        std::filesystem::file_size(trf_output_path, ec) == 0) {
        logger()->error(
            "vidstabdetect did not produce a transforms file at '{}'; "
            "make sure the FFmpeg build includes libvidstab (vidstabdetect filter)",
            trf_output_path.string()
        );
        return -1;
    }

    logger()->info("Stabilization prepass completed successfully after processing {} frames", frame_count);
    return 0;
}

}  // namespace video2x
