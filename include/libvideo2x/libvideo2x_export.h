#pragma once

#ifdef _WIN32
#ifdef LIBVIDEO2X_EXPORTS
#define LIBVIDEO2X_API __declspec(dllexport)
#else
#define LIBVIDEO2X_API __declspec(dllimport)
#endif
#else
#define LIBVIDEO2X_API
#endif

// Function multiversioning for hot paths. target_clones relies on ELF ifunc and x86-64
// microarchitecture levels, so it only applies to x86-64 Linux; MSVC ignores the attribute
// and Apple Clang on arm64 warns and ignores it, so expand to nothing there.
#if defined(__x86_64__) && defined(__linux__)
#define V2X_TARGET_CLONES [[gnu::target_clones("arch=x86-64-v4", "arch=x86-64-v3", "default")]]
#else
#define V2X_TARGET_CLONES
#endif
