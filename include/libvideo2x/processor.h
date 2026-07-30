#pragma once

#include <variant>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavutil/buffer.h>
}

#include "fsutils.h"

namespace video2x {
namespace processors {

enum class FrameDomain {
    Cpu,
    Vulkan
};

enum class ProcessingMode {
    Filter,
    Interpolate,
};

enum class ProcessorType {
    None,
    Libplacebo,
    RealESRGAN,
    RealCUGAN,
    RIFE,
    SPAN,
    VidStab,
    Denoise,
    HDR,
    FFmpegGraph
};

struct LibplaceboConfig {
    fsutils::StringType shader_path;
};

struct RealESRGANConfig {
    bool tta_mode = false;
    fsutils::StringType model_name;
};

struct RealCUGANConfig {
    bool tta_mode = false;
    int num_threads = 1;
    int syncgap = 3;
    fsutils::StringType model_name;
};

struct RIFEConfig {
    bool tta_mode = false;
    bool tta_temporal_mode = false;
    bool uhd_mode = false;
    int num_threads = 0;
    fsutils::StringType model_name;
};

struct SPANConfig {
    bool tta_mode = false;
    fsutils::StringType model_name;
};

struct VidStabConfig {
    int shakiness = 5;
    int smoothing = 15;
    int zoom = 0;
    bool optzoom = true;
    std::filesystem::path trf_path;
};

struct DenoiseConfig {
    std::string algo = "hqdn3d";
    float luma_spatial = 4.0f;
};

struct HDRConfig {
    std::string format = "pq";
    int target_peak = 1000;
};

struct FFmpegGraphConfig {
    std::string graph_desc;
};

// Unified filter configuration
struct ProcessorConfig {
    ProcessorType processor_type = ProcessorType::None;
    int width = 0;
    int height = 0;
    int scaling_factor = 0;
    int noise_level = -1;
    int frm_rate_mul = 0;
    float scn_det_thresh = 0.0f;
    std::variant<
        LibplaceboConfig,
        RealESRGANConfig,
        RealCUGANConfig,
        RIFEConfig,
        SPANConfig,
        VidStabConfig,
        DenoiseConfig,
        HDRConfig,
        FFmpegGraphConfig>
        config;
};

class Processor {
   public:
    virtual ~Processor() = default;
    virtual int init(AVCodecContext* dec_ctx, AVCodecContext* enc_ctx, AVBufferRef* hw_ctx) = 0;
    virtual int flush(std::vector<AVFrame*>&) { return 0; }
    virtual ProcessingMode get_processing_mode() const = 0;
    virtual ProcessorType get_processor_type() const = 0;
    virtual FrameDomain get_input_domain() const { return FrameDomain::Vulkan; }
    virtual FrameDomain get_output_domain() const { return FrameDomain::Vulkan; }
    virtual int get_input_delay() const { return 0; }
    virtual void get_output_dimensions(
        const ProcessorConfig& proc_cfg,
        int in_width,
        int in_height,
        int& width,
        int& height
    ) const = 0;
};

// Abstract base class for filters
class Filter : public Processor {
   public:
    ProcessingMode get_processing_mode() const override { return ProcessingMode::Filter; }
    virtual int filter(AVFrame* in_frame, AVFrame** out_frame) = 0;
};

// Abstract base class for interpolators
class Interpolator : public Processor {
   public:
    ProcessingMode get_processing_mode() const override { return ProcessingMode::Interpolate; }
    virtual int
    interpolate(AVFrame* prev_frame, AVFrame* in_frame, AVFrame** out_frame, float time_step) = 0;
};

}  // namespace processors
}  // namespace video2x
