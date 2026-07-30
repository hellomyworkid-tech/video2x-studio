#include "libvideo2x.h"

extern "C" {
#include <libavutil/avutil.h>
}

#include <spdlog/spdlog.h>

#include "avutils.h"
#include "decoder.h"
#include "encoder.h"
#include "logger_manager.h"
#include "processor.h"
#include "processor_factory.h"
#include "stab_prepass.h"

namespace video2x {

VideoProcessor::VideoProcessor(
    const std::vector<processors::ProcessorConfig> proc_cfgs,
    const encoder::EncoderConfig enc_cfg,
    const uint32_t vk_device_idx,
    const AVHWDeviceType hw_device_type,
    const bool benchmark
)
    : proc_cfgs_(proc_cfgs),
      enc_cfg_(enc_cfg),
      vk_device_idx_(vk_device_idx),
      hw_device_type_(hw_device_type),
      benchmark_(benchmark) {}

[[gnu::target_clones("arch=x86-64-v4", "arch=x86-64-v3", "default")]]
int VideoProcessor::process(
    const std::filesystem::path in_fname,
    const std::filesystem::path out_fname
) {
    int ret = 0;

    // Helper lambda to handle errors:
    auto handle_error = [&](int error_code, const std::string& msg) {
        // Format and log the error message
        char errbuf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(error_code, errbuf, sizeof(errbuf));
        logger()->critical("{}: {}", msg, errbuf);

        // Set the video processor state to failed and return the error code
        state_.store(VideoProcessorState::Failed);
        return error_code;
    };

    // Set the video processor state to running
    state_.store(VideoProcessorState::Running);

    // Detect an HDR stage and propagate its settings to the encoder config
    for (auto& cfg : proc_cfgs_) {
        if (cfg.processor_type == processors::ProcessorType::HDR &&
            std::holds_alternative<processors::HDRConfig>(cfg.config)) {
            const auto& hdr_cfg = std::get<processors::HDRConfig>(cfg.config);
            enc_cfg_.is_hdr = true;
            enc_cfg_.hdr_format = hdr_cfg.format;
            enc_cfg_.hdr_peak = hdr_cfg.target_peak;
            break;
        }
    }

    // HDR output requires a 10-bit capable codec; libx264 is 8-bit only
    if (enc_cfg_.is_hdr && enc_cfg_.codec == "libx264") {
        logger()->warn(
            "HDR output is not supported by libx264 (8-bit only); switching codec to libx265"
        );
        enc_cfg_.codec = "libx265";
    }

    // Run the stabilization analysis prepass if a VidStab stage is present.
    // The transforms file is unique per output file and removed after processing.
    std::filesystem::path trf_path;
    for (auto& cfg : proc_cfgs_) {
        if (cfg.processor_type == processors::ProcessorType::VidStab &&
            std::holds_alternative<processors::VidStabConfig>(cfg.config)) {
            auto& stab_cfg = std::get<processors::VidStabConfig>(cfg.config);
            trf_path = out_fname.parent_path() / (out_fname.stem().wstring() + L".transforms.trf");
            stab_cfg.trf_path = trf_path;

            ret = StabilizationPrepass::analyze(in_fname, trf_path, stab_cfg);
            if (ret < 0) {
                return handle_error(ret, "Failed stabilization analysis prepass");
            }
            break;
        }
    }

    // RAII cleanup for the vidstab transforms file
    struct TrfCleanup {
        std::filesystem::path path;
        ~TrfCleanup() {
            if (!path.empty()) {
                std::error_code ec;
                std::filesystem::remove(path, ec);
            }
        }
    } trf_cleanup{trf_path};

    // Create the hardware device context
    std::unique_ptr<AVBufferRef, decltype(&avutils::av_bufferref_deleter)> hw_ctx(
        nullptr, &avutils::av_bufferref_deleter
    );

    if (hw_device_type_ != AV_HWDEVICE_TYPE_NONE) {
        AVBufferRef* tmp_hw_ctx = nullptr;
        ret = av_hwdevice_ctx_create(&tmp_hw_ctx, hw_device_type_, nullptr, nullptr, 0);
        if (ret < 0) {
            return handle_error(ret, "Error initializing hardware device context");
        }
        hw_ctx.reset(tmp_hw_ctx);
    }

    // Initialize the input decoder
    decoder::Decoder decoder;
    ret = decoder.init(hw_device_type_, hw_ctx.get(), in_fname);
    if (ret < 0) {
        return handle_error(ret, "Failed to initialize decoder");
    }

    AVFormatContext* ifmt_ctx = decoder.get_format_context();
    AVCodecContext* dec_ctx = decoder.get_codec_context();
    int in_vstream_idx = decoder.get_video_stream_index();

    // Compute the chain's output dimensions statically from the configurations,
    // so the (single, real) encoder can be created up front with the right size
    int output_width = 0, output_height = 0;
    ret = processors::FilterChain::compute_output_dimensions(
        proc_cfgs_, dec_ctx->width, dec_ctx->height, output_width, output_height
    );
    if (ret != 0 || output_width <= 0 || output_height <= 0) {
        return handle_error(-1, "Failed to determine the output dimensions");
    }

    // Determine the effective frame rate multiplier from the interpolation stage
    int frm_rate_mul = 0;
    for (const auto& cfg : proc_cfgs_) {
        if (cfg.processor_type == processors::ProcessorType::RIFE && cfg.frm_rate_mul > 0) {
            frm_rate_mul = cfg.frm_rate_mul;
            break;
        }
    }

    // Initialize the encoder (exactly once)
    encoder::Encoder encoder;
    ret = encoder.init(
        hw_ctx.get(),
        out_fname,
        ifmt_ctx,
        dec_ctx,
        enc_cfg_,
        output_width,
        output_height,
        frm_rate_mul,
        in_vstream_idx
    );
    if (ret < 0) {
        return handle_error(ret, "Failed to initialize encoder");
    }

    // Initialize the filter chain against the real encoder context
    processors::FilterChain filter_chain;
    ret = filter_chain.init(
        proc_cfgs_, dec_ctx, encoder.get_encoder_context(), hw_ctx.get(), vk_device_idx_
    );
    if (ret < 0) {
        return handle_error(ret, "Failed to initialize FilterChain");
    }

    // Process frames using the encoder and decoder
    ret = process_frames(decoder, encoder, filter_chain);
    if (ret < 0) {
        return handle_error(ret, "Error processing frames");
    }

    // Write the output file trailer
    ret = av_write_trailer(encoder.get_format_context());
    if (ret < 0) {
        return handle_error(ret, "Error writing output file trailer");
    }

    // Processing has completed successfully
    state_.store(VideoProcessorState::Completed);
    return 0;
}

// Process frames using the filter chain.
int VideoProcessor::process_frames(
    decoder::Decoder& decoder,
    encoder::Encoder& encoder,
    processors::FilterChain& filter_chain
) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = 0;

    // Get required objects
    AVFormatContext* ifmt_ctx = decoder.get_format_context();
    AVCodecContext* dec_ctx = decoder.get_codec_context();
    int in_vstream_idx = decoder.get_video_stream_index();
    AVFormatContext* ofmt_ctx = encoder.get_format_context();
    AVCodecContext* enc_ctx = encoder.get_encoder_context();
    int* stream_map = encoder.get_stream_map();

    // Previous frames for interpolation (post-pre-filter and raw for scene detection)
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> prev_frame(
        nullptr, &avutils::av_frame_deleter
    );
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> prev_raw_frame(
        nullptr, &avutils::av_frame_deleter
    );

    // Allocate space for the decoded frames
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> frame(
        av_frame_alloc(), &avutils::av_frame_deleter
    );
    if (frame == nullptr) {
        logger()->critical("Error allocating frame");
        return AVERROR(ENOMEM);
    }

    // Allocate space for the decoded packets
    std::unique_ptr<AVPacket, decltype(&avutils::av_packet_deleter)> packet(
        av_packet_alloc(), &avutils::av_packet_deleter
    );
    if (packet == nullptr) {
        logger()->critical("Error allocating packet");
        return AVERROR(ENOMEM);
    }

    // Set the total number of frames in the VideoProcessingContext
    logger()->debug("Estimating the total number of frames to process");
    total_frames_ = avutils::get_video_frame_count(ifmt_ctx, in_vstream_idx);

    if (total_frames_ <= 0) {
        logger()->warn("Unable to determine the total number of frames");
        total_frames_ = 0;
    } else {
        logger()->debug("{} frames to process", total_frames_.load());
    }

    if (filter_chain.has_interpolator() && filter_chain.get_frm_rate_mul() > 0) {
        total_frames_.store(total_frames_.load() * filter_chain.get_frm_rate_mul());
    }

    // Drain all currently-decodable frames and push them through the processing chain.
    // Returns 0 when no more frames are available right now (EAGAIN) or the decoder has
    // been fully drained (AVERROR_EOF); returns a negative AVERROR code on failure.
    auto drain_decoder = [&]() -> int {
        while (state_.load() != VideoProcessorState::Aborted) {
            // Sleep for 100 ms if processing is paused
            if (state_.load() == VideoProcessorState::Paused) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            // Receive the decoded frame from the decoder
            int dret = avcodec_receive_frame(dec_ctx, frame.get());
            if (dret == AVERROR(EAGAIN) || dret == AVERROR_EOF) {
                // No more frames from this packet, or decoder fully drained after flush
                return 0;
            } else if (dret < 0) {
                av_strerror(dret, errbuf, sizeof(errbuf));
                logger()->critical("Error decoding video frame: {}", errbuf);
                return dret;
            }

            // Calculate this frame's presentation timestamp (PTS)
            if (enc_cfg_.recalculate_pts) {
                frame->pts = av_rescale_q(
                    frame_idx_, av_inv_q(enc_ctx->framerate), enc_ctx->time_base
                );
            }

            // Process the frame based on the chain's composition
            AVFrame* proc_frame = nullptr;
            int pret;
            if (!filter_chain.has_interpolator()) {
                pret = process_filtering(filter_chain, encoder, frame.get(), proc_frame);
            } else {
                pret = process_interpolation(
                    filter_chain, encoder, prev_frame, prev_raw_frame, frame.get(), proc_frame
                );
            }
            if (pret < 0 && pret != AVERROR(EAGAIN)) {
                return pret;
            }
            av_frame_unref(frame.get());
            frame_idx_.fetch_add(1);
            logger()->debug("Processed frame {}/{}", frame_idx_.load(), total_frames_.load());
        }
        return 0;
    };

    // Read frames from the input file
    while (state_.load() != VideoProcessorState::Aborted) {
        ret = av_read_frame(ifmt_ctx, packet.get());
        if (ret < 0) {
            if (ret == AVERROR_EOF) {
                logger()->debug("Reached end of file");
                break;
            }
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error reading packet: {}", errbuf);
            return ret;
        }

        if (packet->stream_index == in_vstream_idx) {
            // Send the packet to the decoder for decoding
            ret = avcodec_send_packet(dec_ctx, packet.get());
            if (ret < 0) {
                av_strerror(ret, errbuf, sizeof(errbuf));
                logger()->critical("Error sending packet to decoder: {}", errbuf);
                return ret;
            }

            // Process frames decoded from the packet
            ret = drain_decoder();
            if (ret < 0) {
                return ret;
            }
        } else if ((enc_cfg_.copy_audio_streams || enc_cfg_.copy_subtitle_streams) &&
                   stream_map[packet->stream_index] >= 0) {
            ret = write_raw_packet(packet.get(), ifmt_ctx, ofmt_ctx, stream_map);
            if (ret < 0) {
                return ret;
            }
        }
        av_packet_unref(packet.get());
    }

    // Flush the decoder to drain frames delayed by B-frame reordering; without this,
    // the last few frames of every video would be silently dropped.
    if (state_.load() != VideoProcessorState::Aborted) {
        ret = avcodec_send_packet(dec_ctx, nullptr);
        if (ret < 0 && ret != AVERROR_EOF) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error flushing decoder: {}", errbuf);
            return ret;
        }
        ret = drain_decoder();
        if (ret < 0) {
            return ret;
        }
    }

    // Flush the filter chain, keeping every frame on its correct processing path
    if (!filter_chain.has_interpolator()) {
        // No interpolator: cascaded flush yields final output frames
        std::vector<AVFrame*> flushed_frames;
        ret = filter_chain.flush(flushed_frames);
        if (ret < 0) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error flushing FilterChain: {}", errbuf);
            return ret;
        }

        for (AVFrame* raw_frame : flushed_frames) {
            std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> flushed_frame(
                raw_frame, &avutils::av_frame_deleter
            );
            ret = write_frame(flushed_frame.get(), encoder);
            if (ret < 0) {
                return ret;
            }
        }
    } else {
        // Interpolator present: pre-stage tail frames are additional interpolation inputs
        std::vector<AVFrame*> pre_tail_frames;
        ret = filter_chain.flush_pre(pre_tail_frames);
        if (ret < 0) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error flushing pre-interp stages: {}", errbuf);
            return ret;
        }

        for (AVFrame* tail_frame : pre_tail_frames) {
            // interpolate_and_write takes ownership of the frame
            ret = interpolate_and_write(
                filter_chain, encoder, prev_frame, prev_raw_frame, tail_frame, nullptr
            );
            if (ret < 0) {
                return ret;
            }
        }

        // Flush the interpolator itself (no-op for RIFE, but honored for future models)
        processors::Interpolator* interpolator = filter_chain.get_interpolator();
        if (interpolator != nullptr) {
            std::vector<AVFrame*> interp_tail;
            ret = interpolator->flush(interp_tail);
            if (ret < 0) {
                av_strerror(ret, errbuf, sizeof(errbuf));
                logger()->critical("Error flushing interpolator: {}", errbuf);
                return ret;
            }
            for (AVFrame* f : interp_tail) {
                ret = write_frame_through_post(filter_chain, encoder, f);
                if (ret < 0) {
                    return ret;
                }
            }
        }

        // Flush the post-interp stages' own buffered frames
        std::vector<AVFrame*> post_tail;
        ret = filter_chain.flush_post(post_tail);
        if (ret < 0) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error flushing post-interp stages: {}", errbuf);
            return ret;
        }
        for (AVFrame* f : post_tail) {
            std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> holder(
                f, &avutils::av_frame_deleter
            );
            ret = write_frame(holder.get(), encoder);
            if (ret < 0) {
                return ret;
            }
        }
    }

    // Flush the encoder
    ret = encoder.flush();
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->critical("Error flushing encoder: {}", errbuf);
        return ret;
    }

    return ret;
}

int VideoProcessor::write_frame(AVFrame* frame, encoder::Encoder& encoder) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = 0;

    if (!benchmark_) {
        // The output-side counter keeps PTS correct even when upstream stages
        // buffer/delay frames (e.g. vidstabtransform's smoothing window)
        ret = encoder.write_frame(frame, out_frame_idx_.load());
        if (ret < 0) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error encoding/writing frame: {}", errbuf);
            return ret;
        }
    }
    out_frame_idx_.fetch_add(1);
    return ret;
}

int VideoProcessor::write_raw_packet(
    AVPacket* packet,
    AVFormatContext* ifmt_ctx,
    AVFormatContext* ofmt_ctx,
    int* stream_map
) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = 0;

    AVStream* in_stream = ifmt_ctx->streams[packet->stream_index];
    int out_stream_idx = stream_map[packet->stream_index];
    AVStream* out_stream = ofmt_ctx->streams[out_stream_idx];

    av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
    packet->stream_index = out_stream_idx;

    ret = av_interleaved_write_frame(ofmt_ctx, packet);
    if (ret < 0) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->critical("Error muxing audio/subtitle packet: {}", errbuf);
    }
    return ret;
}

int VideoProcessor::process_filtering(
    processors::FilterChain& filter_chain,
    encoder::Encoder& encoder,
    AVFrame* frame,
    AVFrame* proc_frame
) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = filter_chain.filter(frame, &proc_frame);

    if (ret < 0 && ret != AVERROR(EAGAIN)) {
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->critical("Error filtering frame: {}", errbuf);
    } else if (ret == 0 && proc_frame != nullptr) {
        auto processed_frame = std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>(
            proc_frame, &avutils::av_frame_deleter
        );
        ret = write_frame(processed_frame.get(), encoder);
    }
    return ret;
}

int VideoProcessor::process_interpolation(
    processors::FilterChain& filter_chain,
    encoder::Encoder& encoder,
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_frame,
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_raw_frame,
    AVFrame* frame,
    AVFrame*
) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];

    // Run the raw input frame through the pre-interp stages
    AVFrame* chain_filtered_frame = nullptr;
    int ret = filter_chain.filter_pre(frame, &chain_filtered_frame);
    if (ret < 0 || chain_filtered_frame == nullptr) {
        if (ret >= 0) {
            ret = AVERROR_EXTERNAL;
        }
        av_strerror(ret, errbuf, sizeof(errbuf));
        logger()->critical("Error pre-filtering frame for interpolation: {}", errbuf);
        return ret;
    }

    // interpolate_and_write takes ownership of the filtered frame
    return interpolate_and_write(
        filter_chain, encoder, prev_frame, prev_raw_frame, chain_filtered_frame, frame
    );
}

int VideoProcessor::interpolate_and_write(
    processors::FilterChain& filter_chain,
    encoder::Encoder& encoder,
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_frame,
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)>& prev_raw_frame,
    AVFrame* filtered_frame,
    AVFrame* raw_frame
) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE];
    int ret = 0;

    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> filtered_holder(
        filtered_frame, &avutils::av_frame_deleter
    );

    processors::Interpolator* interpolator = filter_chain.get_interpolator();
    int frm_rate_mul = filter_chain.get_frm_rate_mul() > 0 ? filter_chain.get_frm_rate_mul() : 2;

    float time_step = 1.0f / static_cast<float>(frm_rate_mul);
    float current_time_step = time_step;

    // Scene-cut detection on RAW (unprocessed) frames: denoising/upscaling alters
    // texture and would distort the diff metric, and raw frames are much cheaper
    bool skip_frame = false;
    float scn_det_thresh = filter_chain.get_scn_det_thresh();
    if (raw_frame != nullptr && prev_raw_frame.get() != nullptr &&
        scn_det_thresh < 100.0f && scn_det_thresh > 0.0f) {
        float frame_diff = avutils::get_frame_diff(prev_raw_frame.get(), raw_frame);
        if (frame_diff > scn_det_thresh) {
            logger()->debug(
                "Scene change detected ({:.2f}%), skipping frame {}", frame_diff, frame_idx_.load()
            );
            skip_frame = true;
        }
    }

    // Write the interpolated frames, each through the post-interp stages
    for (int i = 0; i < frm_rate_mul - 1; i++) {
        // Skip interpolation if this is the first frame
        if (prev_frame == nullptr) {
            break;
        }

        AVFrame* proc_frame = nullptr;
        if (!skip_frame && interpolator != nullptr) {
            ret = interpolator->interpolate(
                prev_frame.get(), filtered_holder.get(), &proc_frame, current_time_step
            );
        } else {
            ret = 0;
            proc_frame = av_frame_clone(prev_frame.get());
            if (proc_frame == nullptr) {
                ret = AVERROR(ENOMEM);
            }
        }

        if (ret < 0 && ret != AVERROR(EAGAIN)) {
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->critical("Error interpolating frame: {}", errbuf);
            return ret;
        } else if (ret == 0 && proc_frame != nullptr) {
            ret = write_frame_through_post(filter_chain, encoder, proc_frame);
            if (ret < 0) {
                return ret;
            }
        }

        frame_idx_.fetch_add(1);
        current_time_step += time_step;
    }

    // Write the original (pre-filtered) frame through the post-interp stages
    AVFrame* original_out = av_frame_clone(filtered_holder.get());
    if (original_out == nullptr) {
        return AVERROR(ENOMEM);
    }
    ret = write_frame_through_post(filter_chain, encoder, original_out);
    if (ret < 0) {
        return ret;
    }

    // Update the previous frames (pre-post for the interpolator, raw for scene detection)
    prev_frame.reset(av_frame_clone(filtered_holder.get()));
    if (prev_frame == nullptr) {
        return AVERROR(ENOMEM);
    }
    if (raw_frame != nullptr) {
        prev_raw_frame.reset(av_frame_clone(raw_frame));
        if (prev_raw_frame == nullptr) {
            return AVERROR(ENOMEM);
        }
    }
    return ret;
}

int VideoProcessor::write_frame_through_post(
    processors::FilterChain& filter_chain,
    encoder::Encoder& encoder,
    AVFrame* frame
) {
    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> holder(
        frame, &avutils::av_frame_deleter
    );

    AVFrame* post_out = nullptr;
    int ret = filter_chain.filter_post(holder.get(), &post_out);
    if (ret < 0) {
        return ret;
    }
    if (post_out == nullptr) {
        // A post stage buffered the frame; it will be emitted at flush time
        return 0;
    }

    std::unique_ptr<AVFrame, decltype(&avutils::av_frame_deleter)> post_holder(
        post_out, &avutils::av_frame_deleter
    );
    return write_frame(post_holder.get(), encoder);
}

}  // namespace video2x
