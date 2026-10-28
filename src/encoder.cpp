#include "encoder.h"

#include <spdlog/spdlog.h>

extern "C" {
#include <libavutil/mastering_display_metadata.h>
#include <libavutil/opt.h>
}

#include "avutils.h"
#include "conversions.h"
#include "logger_manager.h"

namespace video2x {
namespace encoder {

Encoder::Encoder()
    : ofmt_ctx_(nullptr), enc_ctx_(nullptr), out_vstream_idx_(-1), stream_map_(nullptr) {}

Encoder::~Encoder() {
    if (enc_ctx_) {
        avcodec_free_context(&enc_ctx_);
    }
    if (ofmt_ctx_) {
        if (!(ofmt_ctx_->oformat->flags & AVFMT_NOFILE)) {
            avio_closep(&ofmt_ctx_->pb);
        }
        avformat_free_context(ofmt_ctx_);
    }
    if (stream_map_) {
        av_free(stream_map_);
    }
}

int Encoder::init(
    AVBufferRef* hw_ctx,
    const std::filesystem::path& out_fpath,
    AVFormatContext* ifmt_ctx,
    AVCodecContext* dec_ctx,
    EncoderConfig& enc_cfg,
    int width,
    int height,
    int frm_rate_mul,
    int in_vstream_idx
) {
    int ret;

    // Copy the encoder configuration
    enc_cfg_ = enc_cfg;

    // Allocate the output format context
    avformat_alloc_output_context2(&ofmt_ctx_, nullptr, nullptr, out_fpath.u8string().c_str());
    if (!ofmt_ctx_) {
        logger()->error("Could not create output context");
        return AVERROR_UNKNOWN;
    }

    // Find the encoder
    const AVCodec* encoder = avcodec_find_encoder_by_name(enc_cfg.codec.c_str());
    if (!encoder) {
        logger()->error("Could not find encoder '{}'", enc_cfg.codec);
        return AVERROR_ENCODER_NOT_FOUND;
    }

    // Create a new video stream in the output file
    AVStream* out_vstream = avformat_new_stream(ofmt_ctx_, nullptr);
    if (!out_vstream) {
        logger()->error("Failed to allocate the output video stream");
        return AVERROR_UNKNOWN;
    }
    out_vstream_idx_ = out_vstream->index;

    // Allocate the encoder context
    enc_ctx_ = avcodec_alloc_context3(encoder);
    if (!enc_ctx_) {
        logger()->error("Failed to allocate the encoder context");
        return AVERROR(ENOMEM);
    }

    // Set hardware device context
    if (hw_ctx != nullptr) {
        enc_ctx_->hw_device_ctx = av_buffer_ref(hw_ctx);
    }

    // Copy the color properties from the decoder context
    enc_ctx_->color_range = dec_ctx->color_range;
    enc_ctx_->color_primaries = dec_ctx->color_primaries;
    enc_ctx_->color_trc = dec_ctx->color_trc;
    enc_ctx_->colorspace = dec_ctx->colorspace;
    enc_ctx_->chroma_sample_location = dec_ctx->chroma_sample_location;

    // Extra options copied from the decoder context
    enc_ctx_->sample_aspect_ratio = dec_ctx->sample_aspect_ratio;

    // Set basic video options
    enc_ctx_->width = width;
    enc_ctx_->height = height;

    // Set rate control and compression options
    enc_ctx_->bit_rate = enc_cfg.bit_rate;
    enc_ctx_->rc_buffer_size = enc_cfg.rc_buffer_size;
    enc_ctx_->rc_min_rate = enc_cfg.rc_min_rate;
    enc_ctx_->rc_max_rate = enc_cfg.rc_max_rate;
    enc_ctx_->qmin = enc_cfg.qmin;
    enc_ctx_->qmax = enc_cfg.qmax;

    // Set GOP and frame structure options
    enc_ctx_->gop_size = enc_cfg.gop_size;
    enc_ctx_->max_b_frames = enc_cfg.max_b_frames;
    enc_ctx_->keyint_min = enc_cfg.keyint_min;
    enc_ctx_->refs = enc_cfg.refs;

    // Set performance and threading options
    enc_ctx_->thread_count = enc_cfg.thread_count;

    // Set latency and buffering options
    enc_ctx_->delay = enc_cfg.delay;

    // Set the pixel format
    if (enc_cfg.is_hdr) {
        enc_ctx_->pix_fmt = AV_PIX_FMT_YUV420P10LE;
        enc_ctx_->color_primaries = AVCOL_PRI_BT2020;
        enc_ctx_->color_trc = (enc_cfg.hdr_format == "hlg") ? AVCOL_TRC_ARIB_STD_B67 : AVCOL_TRC_SMPTE2084;
        enc_ctx_->colorspace = AVCOL_SPC_BT2020_NCL;
        logger()->info("Configured 10-bit HDR encoder settings: BT.2020 / {}", enc_cfg.hdr_format);
    } else if (enc_cfg.pix_fmt != AV_PIX_FMT_NONE) {
        // Use the specified pixel format
        enc_ctx_->pix_fmt = enc_cfg.pix_fmt;
    } else {
        // Automatically select the pixel format
        enc_ctx_->pix_fmt = avutils::get_encoder_default_pix_fmt(encoder, dec_ctx->pix_fmt);
        if (enc_ctx_->pix_fmt == AV_PIX_FMT_NONE) {
            logger()->error("Could not get the default pixel format for the encoder");
            return AVERROR(EINVAL);
        }
        logger()->debug("Auto-selected pixel format: {}", av_get_pix_fmt_name(enc_ctx_->pix_fmt));
    }

    if (frm_rate_mul > 0) {
        AVRational in_frame_rate = avutils::get_video_frame_rate(ifmt_ctx, in_vstream_idx);
        enc_ctx_->framerate = {in_frame_rate.num * frm_rate_mul, in_frame_rate.den};
        // Interpolated frames land at fractions of each source gap. A 1/framerate time
        // base is too coarse for variable-frame-rate input (neighbours round onto the
        // same tick and get dropped downstream), so subdivide the decoder's time base
        // by the multiplier: every k/mul position of an integer-tick gap is then exact.
        if (dec_ctx->time_base.num > 0 && dec_ctx->time_base.den > 0) {
            enc_ctx_->time_base = av_mul_q(dec_ctx->time_base, {1, frm_rate_mul});
        } else {
            enc_ctx_->time_base = av_inv_q(enc_ctx_->framerate);
        }
    } else {
        // Set the output video's time base
        if (dec_ctx->time_base.num > 0 && dec_ctx->time_base.den > 0) {
            enc_ctx_->time_base = dec_ctx->time_base;
        } else {
            enc_ctx_->time_base = av_inv_q(av_guess_frame_rate(ifmt_ctx, out_vstream, nullptr));
        }

        // Set the output video's frame rate
        if (dec_ctx->framerate.num > 0 && dec_ctx->framerate.den > 0) {
            enc_ctx_->framerate = dec_ctx->framerate;
        } else {
            enc_ctx_->framerate = av_guess_frame_rate(ifmt_ctx, out_vstream, nullptr);
        }
    }

    // Set extra AVOptions
    for (const auto& [opt_name, opt_value] : enc_cfg.extra_opts) {
        std::string opt_name_str = opt_name;
        std::string opt_value_str = opt_value;
        logger()->debug("Setting encoder option '{}' to '{}'", opt_name_str, opt_value_str);

        // Search the encoder's private options first (same precedence as before), then the
        // generic AVCodecContext options: VideoToolbox's constant-quality mode is only reachable
        // through the generic flags=+qscale and global_quality
        ret = av_opt_set(
            enc_ctx_, opt_name_str.c_str(), opt_value_str.c_str(), AV_OPT_SEARCH_CHILDREN
        );
        if (ret < 0) {
            char errbuf[AV_ERROR_MAX_STRING_SIZE];
            av_strerror(ret, errbuf, sizeof(errbuf));
            logger()->warn(
                "Failed to set encoder option '{}' to '{}': {}", opt_name_str, opt_value_str, errbuf
            );
        }
    }

    // Use global headers if necessary
    if (ofmt_ctx_->oformat->flags & AVFMT_GLOBALHEADER) {
        enc_ctx_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }

    // Open the encoder
    ret = avcodec_open2(enc_ctx_, encoder, nullptr);
    if (ret < 0) {
        logger()->error("Cannot open video encoder");
        return ret;
    }

    // Copy encoder parameters to output video stream
    ret = avcodec_parameters_from_context(out_vstream->codecpar, enc_ctx_);
    if (ret < 0) {
        logger()->error("Failed to copy encoder parameters to output video stream");
        return ret;
    }

#ifdef __APPLE__
    // QuickTime / AVFoundation only play HEVC in MP4/MOV tagged 'hvc1' (FFmpeg defaults to
    // 'hev1', which Finder preview and QuickTime Player refuse to open)
    if (enc_ctx_->codec_id == AV_CODEC_ID_HEVC &&
        (strstr(ofmt_ctx_->oformat->name, "mp4") || strstr(ofmt_ctx_->oformat->name, "mov"))) {
        out_vstream->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
    }
#endif

    // Copy time base and frame rate from the encoder context
    out_vstream->time_base = enc_ctx_->time_base;
    out_vstream->avg_frame_rate = enc_ctx_->framerate;
    out_vstream->r_frame_rate = enc_ctx_->framerate;

#if LIBAVFORMAT_VERSION_MAJOR >= 60
    // Attach HDR10 static metadata (mastering display + content light level)
    // so HDR players/TVs can tone-map the stream correctly.
    // NOTE: av_packet_side_data_add() TAKES OWNERSHIP of the data pointer on
    // success (it wraps, not copies) — the buffer must only be freed when the
    // call fails, otherwise the codecpar cleanup double-frees it at teardown.
    if (enc_cfg_.is_hdr) {
        AVMasteringDisplayMetadata* md = av_mastering_display_metadata_alloc();
        if (md != nullptr) {
            // BT.2020 primaries: R(0.708, 0.292) G(0.170, 0.797) B(0.131, 0.046), D65 white
            md->display_primaries[0][0] = av_make_q(70800, 100000);
            md->display_primaries[0][1] = av_make_q(29200, 100000);
            md->display_primaries[1][0] = av_make_q(17000, 100000);
            md->display_primaries[1][1] = av_make_q(79700, 100000);
            md->display_primaries[2][0] = av_make_q(13100, 100000);
            md->display_primaries[2][1] = av_make_q(4600, 100000);
            md->white_point[0] = av_make_q(31270, 100000);
            md->white_point[1] = av_make_q(32900, 100000);
            md->max_luminance = av_make_q(enc_cfg_.hdr_peak, 1);
            md->min_luminance = av_make_q(5, 1000);
            md->has_primaries = 1;
            md->has_luminance = 1;

            AVPacketSideData* sd = av_packet_side_data_add(
                &out_vstream->codecpar->coded_side_data, &out_vstream->codecpar->nb_coded_side_data,
                AV_PKT_DATA_MASTERING_DISPLAY_METADATA, reinterpret_cast<uint8_t*>(md),
                sizeof(AVMasteringDisplayMetadata), 0
            );
            if (sd == nullptr) {
                logger()->warn("Failed to attach mastering display metadata");
                av_free(md);  // ownership stays with the caller only on failure
            }
        }

        AVContentLightMetadata* cll = av_content_light_metadata_alloc(nullptr);
        if (cll != nullptr) {
            cll->MaxCLL = static_cast<unsigned int>(enc_cfg_.hdr_peak);
            cll->MaxFALL = static_cast<unsigned int>(enc_cfg_.hdr_peak / 4);

            AVPacketSideData* sd = av_packet_side_data_add(
                &out_vstream->codecpar->coded_side_data, &out_vstream->codecpar->nb_coded_side_data,
                AV_PKT_DATA_CONTENT_LIGHT_LEVEL, reinterpret_cast<uint8_t*>(cll),
                sizeof(AVContentLightMetadata), 0
            );
            if (sd == nullptr) {
                logger()->warn("Failed to attach content light level metadata");
                av_free(cll);  // ownership stays with the caller only on failure
            }
        }
    }
#endif

    // Copy other streams if necessary
    if (enc_cfg.copy_audio_streams || enc_cfg.copy_subtitle_streams) {
        // Allocate the stream map
        stream_map_ =
            reinterpret_cast<int*>(av_malloc_array(ifmt_ctx->nb_streams, sizeof(*stream_map_)));
        if (!stream_map_) {
            logger()->error("Could not allocate stream mapping");
            return AVERROR(ENOMEM);
        }

        // Map each input stream to an output stream
        for (int stream_index = 0; stream_index < static_cast<int>(ifmt_ctx->nb_streams);
             stream_index++) {
            AVStream* in_stream = ifmt_ctx->streams[stream_index];
            AVCodecParameters* in_codecpar = in_stream->codecpar;

            // Skip the input video stream as it's already processed
            if (stream_index == in_vstream_idx) {
                stream_map_[stream_index] = out_vstream_idx_;
                continue;
            }

            // Determine if the current stream should be skipped
            switch (in_codecpar->codec_type) {
                case AVMEDIA_TYPE_AUDIO:
                    if (!enc_cfg.copy_audio_streams) {
                        stream_map_[stream_index] = -1;
                        continue;
                    }
                    logger()->debug("Copying audio stream at index: {}", stream_index);
                    break;
                case AVMEDIA_TYPE_SUBTITLE:
                    if (!enc_cfg.copy_subtitle_streams) {
                        stream_map_[stream_index] = -1;
                        continue;
                    }
                    logger()->debug("Copying subtitle stream at index: {}", stream_index);
                    break;
                default:
                    stream_map_[stream_index] = -1;
                    logger()->warn("Skipping unsupported stream type at index: {}", stream_index);
                    continue;
            }

            // Create corresponding output stream for audio and subtitle streams
            AVStream* out_stream = avformat_new_stream(ofmt_ctx_, nullptr);
            if (!out_stream) {
                logger()->error("Failed allocating output stream");
                return AVERROR_UNKNOWN;
            }

            // Copy codec parameters from the input stream to the output stream
            ret = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
            if (ret < 0) {
                logger()->error("Failed to copy codec parameters");
                return ret;
            }
            out_stream->codecpar->codec_tag = 0;

            // Copy all metadata from the input stream to the output stream
            AVDictionaryEntry* tag = nullptr;
            while ((tag = av_dict_get(in_stream->metadata, "", tag, AV_DICT_IGNORE_SUFFIX)) !=
                   nullptr) {
                av_dict_set(&out_stream->metadata, tag->key, tag->value, 0);
            }

            // Copy time base
            out_stream->time_base = in_stream->time_base;

            // Map input stream index to output stream index
            logger()->debug("Stream mapping: {} (in) -> {} (out)", stream_index, out_stream->index);
            stream_map_[stream_index] = out_stream->index;
        }
    }

    // Open the output file
    if (!(ofmt_ctx_->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&ofmt_ctx_->pb, out_fpath.u8string().c_str(), AVIO_FLAG_WRITE);
        if (ret < 0) {
            logger()->error("Could not open output file '{}'", out_fpath.u8string());
            return ret;
        }
    }

    // Write the output file header
    ret = avformat_write_header(ofmt_ctx_, nullptr);
    if (ret < 0) {
        logger()->error("Error writing output file header");
        return ret;
    }

    return 0;
}

V2X_TARGET_CLONES
int Encoder::write_frame(AVFrame* frame, int64_t frame_idx) {
    AVFrame* converted_frame = nullptr;
    int ret;

    // Let the encoder decide the frame type
    frame->pict_type = AV_PICTURE_TYPE_NONE;

    // Single owner of output timestamps. By default the source timing carried by the
    // frame (in its own time base) is preserved; recalculate_pts forces an index-based
    // CFR timeline, which is also the fallback for frames without a timestamp.
    AVRational enc_tb = enc_ctx_->time_base;
    int64_t pts;
    if (enc_cfg_.recalculate_pts || frame->pts == AV_NOPTS_VALUE) {
        pts = av_rescale_q(frame_idx, av_inv_q(enc_ctx_->framerate), enc_tb);
    } else {
        pts = av_rescale_q(frame->pts, avutils::frame_time_base(frame, enc_tb), enc_tb);
    }
    // The muxer treats a non-increasing timestamp as fatal; nudge it forward instead
    // (e.g. two VFR frames rounding onto the same tick of a coarser output time base).
    if (last_pts_ != AV_NOPTS_VALUE && pts <= last_pts_) {
        if (!pts_fixup_warned_) {
            logger()->warn(
                "Non-increasing PTS {} after {}; adjusting to keep the stream monotonic",
                pts,
                last_pts_
            );
            pts_fixup_warned_ = true;
        }
        pts = last_pts_ + 1;
    }
    last_pts_ = pts;
    frame->pts = pts;
    frame->time_base = enc_tb;

    // Convert the frame to the encoder's pixel format if needed
    if (frame->format != enc_ctx_->pix_fmt) {
        converted_frame = conversions::convert_avframe_pix_fmt(frame, enc_ctx_->pix_fmt);
        if (!converted_frame) {
            logger()->error("Error converting frame to encoder's pixel format");
            return AVERROR_EXTERNAL;
        }
        converted_frame->pts = frame->pts;
    }

    AVPacket* enc_pkt = av_packet_alloc();
    if (!enc_pkt) {
        logger()->error("Could not allocate AVPacket");
        return AVERROR(ENOMEM);
    }

    // Send the frame to the encoder
    if (converted_frame != nullptr) {
        ret = avcodec_send_frame(enc_ctx_, converted_frame);
        av_frame_free(&converted_frame);
    } else {
        ret = avcodec_send_frame(enc_ctx_, frame);
    }
    if (ret < 0) {
        logger()->error("Error sending frame to encoder");
        av_packet_free(&enc_pkt);
        return ret;
    }

    // Receive packets from the encoder
    while (ret >= 0) {
        ret = avcodec_receive_packet(enc_ctx_, enc_pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            av_packet_unref(enc_pkt);
            break;
        } else if (ret < 0) {
            logger()->error("Error encoding frame");
            av_packet_free(&enc_pkt);
            return ret;
        }

        // Rescale packet timestamps
        av_packet_rescale_ts(
            enc_pkt, enc_ctx_->time_base, ofmt_ctx_->streams[out_vstream_idx_]->time_base
        );
        enc_pkt->stream_index = out_vstream_idx_;

        // Write the packet
        ret = av_interleaved_write_frame(ofmt_ctx_, enc_pkt);
        av_packet_unref(enc_pkt);
        if (ret < 0) {
            logger()->error("Error muxing packet");
            av_packet_free(&enc_pkt);
            return ret;
        }
    }

    av_packet_free(&enc_pkt);
    return 0;
}

V2X_TARGET_CLONES
int Encoder::flush() {
    int ret;
    AVPacket* enc_pkt = av_packet_alloc();
    if (!enc_pkt) {
        logger()->error("Could not allocate AVPacket");
        return AVERROR(ENOMEM);
    }

    // Send a NULL frame to signal the encoder to flush
    ret = avcodec_send_frame(enc_ctx_, nullptr);
    if (ret < 0) {
        logger()->error("Error sending NULL frame to encoder during flush");
        av_packet_free(&enc_pkt);
        return ret;
    }

    // Receive and write packets until flushing is complete
    while (true) {
        ret = avcodec_receive_packet(enc_ctx_, enc_pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            av_packet_unref(enc_pkt);
            break;
        } else if (ret < 0) {
            logger()->error("Error encoding packet during flush");
            av_packet_free(&enc_pkt);
            return ret;
        }

        // Rescale packet timestamps
        av_packet_rescale_ts(
            enc_pkt, enc_ctx_->time_base, ofmt_ctx_->streams[out_vstream_idx_]->time_base
        );
        enc_pkt->stream_index = out_vstream_idx_;

        // Write the packet
        ret = av_interleaved_write_frame(ofmt_ctx_, enc_pkt);
        av_packet_unref(enc_pkt);
        if (ret < 0) {
            logger()->error("Error muxing packet during flush");
            av_packet_free(&enc_pkt);
            return ret;
        }
    }

    av_packet_free(&enc_pkt);
    return 0;
}

AVCodecContext* Encoder::get_encoder_context() const {
    return enc_ctx_;
}

AVFormatContext* Encoder::get_format_context() const {
    return ofmt_ctx_;
}

int Encoder::get_output_video_stream_index() const {
    return out_vstream_idx_;
}

int* Encoder::get_stream_map() const {
    return stream_map_;
}

}  // namespace encoder
}  // namespace video2x
