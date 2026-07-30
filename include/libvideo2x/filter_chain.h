#pragma once

#include <memory>
#include <vector>

#include "processor.h"

namespace video2x {
namespace processors {

class FilterChain {
   public:
    FilterChain() = default;
    ~FilterChain() = default;

    // Computes the chain's output dimensions purely from the stage configurations.
    // This must be callable before any processor (or the encoder) exists, so that
    // the encoder can be initialized with the correct dimensions up front.
    static int compute_output_dimensions(
        const std::vector<ProcessorConfig>& stage_cfgs,
        int in_w,
        int in_h,
        int& out_w,
        int& out_h
    );

    int init(
        const std::vector<ProcessorConfig>& stage_cfgs,
        AVCodecContext* dec_ctx,
        AVCodecContext* enc_ctx,
        AVBufferRef* hw_ctx,
        uint32_t vk_device_idx
    );

    // Full-chain filter for chains WITHOUT an interpolator (pre + post stages).
    int filter(AVFrame* in_frame, AVFrame** out_frame);

    // Pre-interpolation stages only (used by the interpolation processing loop).
    int filter_pre(AVFrame* in_frame, AVFrame** out_frame);

    // Post-interpolation stages only (1:1 filters, e.g. HDR tone mapping).
    int filter_post(AVFrame* in_frame, AVFrame** out_frame);

    // Flushes the pre-interpolation stages, cascading each stage's buffered tail
    // frames through all remaining pre stages. The returned frames are inputs for
    // the interpolation loop (or, without an interpolator, inputs for the post stages).
    int flush_pre(std::vector<AVFrame*>& out_frames);

    // Flushes the post-interpolation stages, cascading buffered frames downstream.
    int flush_post(std::vector<AVFrame*>& out_frames);

    // Legacy combined flush: cascades pre -> post and returns final output frames.
    // Only valid for chains without an interpolator.
    int flush(std::vector<AVFrame*>& out_frames);

    void get_output_dimensions(int in_w, int in_h, int& out_w, int& out_h) const;
    [[nodiscard]] int get_frm_rate_mul() const;
    [[nodiscard]] float get_scn_det_thresh() const;
    [[nodiscard]] bool has_interpolator() const;
    Interpolator* get_interpolator();

   private:
    // Validates stage ordering constraints (VidStab first, HDR last, single
    // interpolator, denoise before super-resolution). Returns 0 on success.
    int validate(const std::vector<ProcessorConfig>& stage_cfgs) const;

    // Runs a single frame through a list of filter stages. Frees intermediate
    // frames; never frees in_frame. Returns a new frame owned by the caller, or
    // nullptr with ret == 0 when a stage buffered the frame (no output yet).
    static int run_stages(
        std::vector<std::unique_ptr<Processor>>& stages,
        AVFrame* in_frame,
        AVFrame** out_frame
    );

    std::vector<std::unique_ptr<Processor>> pre_interp_stages_;
    std::vector<ProcessorConfig> pre_interp_cfgs_;
    std::unique_ptr<Interpolator> interpolator_;
    ProcessorConfig interp_cfg_;
    std::vector<std::unique_ptr<Processor>> post_interp_stages_;
    std::vector<ProcessorConfig> post_interp_cfgs_;

    std::vector<ProcessorConfig> configs_;
    AVBufferRef* hw_ctx_ = nullptr;
    int frm_rate_mul_ = 0;
};

}  // namespace processors
}  // namespace video2x
