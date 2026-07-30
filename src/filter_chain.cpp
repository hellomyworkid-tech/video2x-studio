#include "filter_chain.h"

#include <spdlog/spdlog.h>

#include "logger_manager.h"
#include "processor_factory.h"

namespace video2x {
namespace processors {

int FilterChain::compute_output_dimensions(
    const std::vector<ProcessorConfig>& stage_cfgs,
    int in_w,
    int in_h,
    int& out_w,
    int& out_h
) {
    int cur_w = in_w;
    int cur_h = in_h;

    for (const auto& cfg : stage_cfgs) {
        switch (cfg.processor_type) {
            case ProcessorType::Libplacebo:
                // The libplacebo filter requires explicit output dimensions
                if (cfg.width > 0 && cfg.height > 0) {
                    cur_w = cfg.width;
                    cur_h = cfg.height;
                } else {
                    logger()->error("FilterChain: Libplacebo stage requires output width/height");
                    return -1;
                }
                break;
            case ProcessorType::RealESRGAN:
            case ProcessorType::RealCUGAN:
            case ProcessorType::SPAN:
                if (cfg.scaling_factor > 0) {
                    cur_w *= cfg.scaling_factor;
                    cur_h *= cfg.scaling_factor;
                }
                break;
            case ProcessorType::RIFE:
            case ProcessorType::VidStab:
            case ProcessorType::Denoise:
            case ProcessorType::HDR:
            case ProcessorType::FFmpegGraph:
                // Dimension-preserving stages (optional explicit override)
                if (cfg.width > 0 && cfg.height > 0) {
                    cur_w = cfg.width;
                    cur_h = cfg.height;
                }
                break;
            case ProcessorType::None:
            default:
                break;
        }
    }

    out_w = cur_w;
    out_h = cur_h;
    return 0;
}

int FilterChain::validate(const std::vector<ProcessorConfig>& stage_cfgs) const {
    int interpolator_count = 0;
    int first_effective = -1;
    int last_effective = -1;
    bool seen_sr = false;

    for (size_t i = 0; i < stage_cfgs.size(); i++) {
        const ProcessorConfig& cfg = stage_cfgs[i];
        if (cfg.processor_type == ProcessorType::None) {
            continue;
        }
        if (first_effective < 0) {
            first_effective = static_cast<int>(i);
        }
        last_effective = static_cast<int>(i);

        switch (cfg.processor_type) {
            case ProcessorType::RIFE:
                interpolator_count++;
                break;
            case ProcessorType::VidStab:
                // vidstab transforms are computed at the source resolution, so the
                // stabilization stage must be the first stage of the chain
                if (static_cast<int>(i) != first_effective) {
                    logger()->critical(
                        "FilterChain: the VidStab stage must be the first stage of the chain"
                    );
                    return -1;
                }
                break;
            case ProcessorType::RealESRGAN:
            case ProcessorType::RealCUGAN:
            case ProcessorType::SPAN:
            case ProcessorType::Libplacebo:
                seen_sr = true;
                break;
            case ProcessorType::Denoise:
                if (seen_sr) {
                    logger()->warn(
                        "FilterChain: denoising after super-resolution is suboptimal; "
                        "noise gets amplified by upscaling"
                    );
                }
                break;
            default:
                break;
        }
    }

    if (interpolator_count > 1) {
        logger()->critical("FilterChain: multiple interpolators in one chain are not allowed");
        return -1;
    }

    // HDR must be the last effective stage (its output goes straight to the encoder)
    if (last_effective >= 0 &&
        stage_cfgs[last_effective].processor_type != ProcessorType::HDR) {
        for (size_t i = 0; i < stage_cfgs.size(); i++) {
            if (stage_cfgs[i].processor_type == ProcessorType::HDR &&
                static_cast<int>(i) != last_effective) {
                logger()->critical("FilterChain: the HDR stage must be the last stage of the chain");
                return -1;
            }
        }
    }

    return 0;
}

int FilterChain::init(
    const std::vector<ProcessorConfig>& stage_cfgs,
    AVCodecContext* dec_ctx,
    AVCodecContext* enc_ctx,
    AVBufferRef* hw_ctx,
    uint32_t vk_device_idx
) {
    configs_ = stage_cfgs;
    hw_ctx_ = hw_ctx;
    pre_interp_stages_.clear();
    pre_interp_cfgs_.clear();
    post_interp_stages_.clear();
    post_interp_cfgs_.clear();
    interpolator_.reset();
    interp_cfg_ = ProcessorConfig{};
    frm_rate_mul_ = 0;

    if (validate(stage_cfgs) != 0) {
        return -1;
    }

    ProcessorFactory& factory = ProcessorFactory::instance();

    bool found_interpolator = false;
    for (const auto& cfg : stage_cfgs) {
        if (cfg.processor_type == ProcessorType::None) {
            continue;
        }

        auto proc = factory.create_processor(cfg, vk_device_idx);
        if (!proc) {
            logger()->error(
                "FilterChain: failed to create processor for type {}",
                static_cast<int>(cfg.processor_type)
            );
            return -1;
        }

        if (proc->init(dec_ctx, enc_ctx, hw_ctx) != 0) {
            logger()->error(
                "FilterChain: failed to initialize processor for type {}",
                static_cast<int>(cfg.processor_type)
            );
            return -1;
        }

        if (proc->get_processing_mode() == ProcessingMode::Interpolate) {
            if (found_interpolator) {
                logger()->error("FilterChain: multiple interpolators found in chain");
                return -1;
            }
            found_interpolator = true;
            interpolator_.reset(static_cast<Interpolator*>(proc.release()));
            interp_cfg_ = cfg;
            if (cfg.frm_rate_mul > 0) {
                frm_rate_mul_ = cfg.frm_rate_mul;
            }
        } else if (!found_interpolator) {
            pre_interp_stages_.push_back(std::move(proc));
            pre_interp_cfgs_.push_back(cfg);
        } else {
            post_interp_stages_.push_back(std::move(proc));
            post_interp_cfgs_.push_back(cfg);
        }
    }

    logger()->info(
        "FilterChain initialized: {} pre-interp stage(s), {} interpolator, {} post-interp stage(s)",
        pre_interp_stages_.size(),
        interpolator_ ? 1 : 0,
        post_interp_stages_.size()
    );
    return 0;
}

int FilterChain::run_stages(
    std::vector<std::unique_ptr<Processor>>& stages,
    AVFrame* in_frame,
    AVFrame** out_frame
) {
    *out_frame = nullptr;
    if (stages.empty()) {
        // No stages: return a clone so the caller always owns the output frame
        // and the input frame's ownership is never transferred.
        *out_frame = av_frame_clone(in_frame);
        return *out_frame ? 0 : AVERROR(ENOMEM);
    }

    AVFrame* current_frame = in_frame;
    bool needs_free = false;

    for (auto& stage : stages) {
        Filter* filter_stage = static_cast<Filter*>(stage.get());
        AVFrame* next_frame = nullptr;

        int ret = filter_stage->filter(current_frame, &next_frame);

        if (needs_free && current_frame) {
            av_frame_free(&current_frame);
        }

        if (ret != 0) {
            *out_frame = nullptr;
            return ret;
        }
        if (!next_frame) {
            // The stage buffered the frame (e.g. vidstabtransform's smoothing window)
            *out_frame = nullptr;
            return 0;
        }

        current_frame = next_frame;
        needs_free = true;
    }

    *out_frame = current_frame;
    return 0;
}

int FilterChain::filter(AVFrame* in_frame, AVFrame** out_frame) {
    AVFrame* pre_out = nullptr;
    int ret = filter_pre(in_frame, &pre_out);
    if (ret != 0 || pre_out == nullptr) {
        *out_frame = nullptr;
        return ret;
    }

    ret = filter_post(pre_out, out_frame);
    av_frame_free(&pre_out);
    return ret;
}

int FilterChain::filter_pre(AVFrame* in_frame, AVFrame** out_frame) {
    return run_stages(pre_interp_stages_, in_frame, out_frame);
}

int FilterChain::filter_post(AVFrame* in_frame, AVFrame** out_frame) {
    return run_stages(post_interp_stages_, in_frame, out_frame);
}

int FilterChain::flush_pre(std::vector<AVFrame*>& out_frames) {
    // Flush each pre stage in order, cascading its tail frames through all
    // remaining pre stages so downstream processors see every frame.
    for (size_t i = 0; i < pre_interp_stages_.size(); i++) {
        std::vector<AVFrame*> stage_frames;
        int ret = pre_interp_stages_[i]->flush(stage_frames);
        if (ret != 0) {
            for (AVFrame* f : stage_frames) {
                av_frame_free(&f);
            }
            return ret;
        }

        for (AVFrame* f : stage_frames) {
            AVFrame* current = f;
            for (size_t j = i + 1; j < pre_interp_stages_.size(); j++) {
                Filter* downstream = static_cast<Filter*>(pre_interp_stages_[j].get());
                AVFrame* next = nullptr;
                ret = downstream->filter(current, &next);
                av_frame_free(&current);
                if (ret != 0) {
                    return ret;
                }
                if (next == nullptr) {
                    // Buffered by a downstream stage; it will come out at its own flush
                    current = nullptr;
                    break;
                }
                current = next;
            }
            if (current != nullptr) {
                out_frames.push_back(current);
            }
        }
    }
    return 0;
}

int FilterChain::flush_post(std::vector<AVFrame*>& out_frames) {
    for (size_t i = 0; i < post_interp_stages_.size(); i++) {
        std::vector<AVFrame*> stage_frames;
        int ret = post_interp_stages_[i]->flush(stage_frames);
        if (ret != 0) {
            for (AVFrame* f : stage_frames) {
                av_frame_free(&f);
            }
            return ret;
        }

        for (AVFrame* f : stage_frames) {
            AVFrame* current = f;
            for (size_t j = i + 1; j < post_interp_stages_.size(); j++) {
                Filter* downstream = static_cast<Filter*>(post_interp_stages_[j].get());
                AVFrame* next = nullptr;
                ret = downstream->filter(current, &next);
                av_frame_free(&current);
                if (ret != 0) {
                    return ret;
                }
                if (next == nullptr) {
                    current = nullptr;
                    break;
                }
                current = next;
            }
            if (current != nullptr) {
                out_frames.push_back(current);
            }
        }
    }
    return 0;
}

int FilterChain::flush(std::vector<AVFrame*>& out_frames) {
    // Pre stages: cascade their tail frames through the remaining pre stages AND
    // the post stages, since there is no interpolator in between.
    std::vector<AVFrame*> pre_frames;
    int ret = flush_pre(pre_frames);
    if (ret != 0) {
        return ret;
    }

    for (AVFrame* f : pre_frames) {
        AVFrame* post_out = nullptr;
        ret = filter_post(f, &post_out);
        av_frame_free(&f);
        if (ret != 0) {
            return ret;
        }
        if (post_out != nullptr) {
            out_frames.push_back(post_out);
        }
    }

    // Post stages' own buffered frames
    return flush_post(out_frames);
}

void FilterChain::get_output_dimensions(int in_w, int in_h, int& out_w, int& out_h) const {
    int current_w = in_w;
    int current_h = in_h;

    auto propagate = [&](const Processor* stage, const ProcessorConfig& cfg) {
        int next_w = current_w;
        int next_h = current_h;
        stage->get_output_dimensions(cfg, current_w, current_h, next_w, next_h);
        current_w = next_w;
        current_h = next_h;
    };

    for (size_t i = 0; i < pre_interp_stages_.size(); i++) {
        propagate(pre_interp_stages_[i].get(), pre_interp_cfgs_[i]);
    }
    if (interpolator_) {
        propagate(interpolator_.get(), interp_cfg_);
    }
    for (size_t i = 0; i < post_interp_stages_.size(); i++) {
        propagate(post_interp_stages_[i].get(), post_interp_cfgs_[i]);
    }

    out_w = current_w;
    out_h = current_h;
}

int FilterChain::get_frm_rate_mul() const {
    return frm_rate_mul_;
}

float FilterChain::get_scn_det_thresh() const {
    // Scene-cut detection is a property of the interpolation stage
    if (interp_cfg_.scn_det_thresh > 0.0f) {
        return interp_cfg_.scn_det_thresh;
    }
    for (const auto& cfg : configs_) {
        if (cfg.scn_det_thresh > 0.0f) {
            return cfg.scn_det_thresh;
        }
    }
    return 0.0f;
}

bool FilterChain::has_interpolator() const {
    return interpolator_ != nullptr;
}

Interpolator* FilterChain::get_interpolator() {
    return interpolator_.get();
}

}  // namespace processors
}  // namespace video2x
