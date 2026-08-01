#pragma once

#include <filesystem>
#include <optional>
#include <string>

namespace video2x {
namespace fsutils {

#ifdef _WIN32
typedef wchar_t CharType;
#define STR(x) L##x
#else
typedef char CharType;
#define STR(x) x
#endif

#ifdef _WIN32
typedef std::wstring StringType;
#else
typedef std::string StringType;
#endif

bool file_is_readable(const std::filesystem::path& path);

std::optional<std::filesystem::path> find_resource(const std::filesystem::path& resource);

std::string path_to_u8string(const std::filesystem::path& path);

std::string wstring_to_u8string(const fsutils::StringType& wstr);

fsutils::StringType path_to_string_type(const std::filesystem::path& path);

fsutils::StringType to_string_type(int value);

/// Escape a filesystem path for embedding as a value inside an FFmpeg filter
/// description (e.g. `vidstabdetect=result=<path>`).
///
/// FFmpeg parses such strings in two passes: the filtergraph parser consumes one
/// level of backslash escaping, then the AVOption parser splits key=value pairs on
/// ':'. A Windows drive letter therefore needs a *doubled* backslash — `C\\:` —
/// so that the AVOption layer still sees `C\:` and treats the colon as literal.
/// A single `C\:` is silently eaten by the first pass and breaks option parsing.
std::string escape_filter_path(const std::filesystem::path& path);

}  // namespace fsutils
}  // namespace video2x
