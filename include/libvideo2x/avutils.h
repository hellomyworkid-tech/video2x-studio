#pragma once

extern "C" {
#include <libavformat/avformat.h>
}

namespace video2x {
namespace avutils {

AVRational get_video_frame_rate(AVFormatContext* ifmt_ctx, int in_vstream_idx);

int64_t get_video_frame_count(AVFormatContext* ifmt_ctx, int in_vstream_idx);

AVPixelFormat get_encoder_default_pix_fmt(const AVCodec* encoder, AVPixelFormat target_pix_fmt);

float get_frame_diff(AVFrame* frame1, AVFrame* frame2);

// Time base of a frame's PTS: the frame's own time_base when set, else the fallback.
// Frames carry their time base through the chain so every stage rescales exactly once.
AVRational frame_time_base(const AVFrame* frame, AVRational fallback);

// Copy src's PTS onto dst rescaled into dst_tb (AV_NOPTS_VALUE preserved), stamping dst_tb.
void copy_frame_pts(const AVFrame* src, AVFrame* dst, AVRational fallback_src_tb, AVRational dst_tb);

// Rescale a frame's PTS in place from src_tb into dst_tb, stamping dst_tb.
void rescale_frame_pts(AVFrame* frame, AVRational src_tb, AVRational dst_tb);

void av_bufferref_deleter(AVBufferRef* bufferref);

void av_frame_deleter(AVFrame* frame);

void av_packet_deleter(AVPacket* packet);

}  // namespace avutils
}  // namespace video2x
