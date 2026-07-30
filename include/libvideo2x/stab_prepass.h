#pragma once

#include <filesystem>
#include <string>
#include "processor.h"

namespace video2x {

class StabilizationPrepass {
   public:
    static int analyze(
        const std::filesystem::path& input_path,
        const std::filesystem::path& trf_output_path,
        const processors::VidStabConfig& config
    );
};

}  // namespace video2x
